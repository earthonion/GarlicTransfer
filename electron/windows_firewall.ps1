# Function = Manage temporary firewall access
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$event = $null
$worker = $null
$app = $null

$firewallWorker = {
    param([int]$appProcessId, [long]$appStart, [int]$supervisorId, [string]$eventName)
    $ErrorActionPreference = 'Stop'
    $env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
    $rules = @()
    $app = $null
    $ready = $null
    $supervisor = $null
    $result = 1
    try {
        Import-Module NetSecurity
        $app = [Diagnostics.Process]::GetProcessById($appProcessId)
        if ($app.StartTime.ToUniversalTime().Ticks -ne $appStart) { throw 'GarlicTransfer exited.' }
        $supervisor = [Diagnostics.Process]::GetProcessById($supervisorId)
        $ready = [Threading.EventWaitHandle]::OpenExisting($eventName, [Security.AccessControl.EventWaitHandleRights]::Modify)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $pathBytes = [Text.Encoding]::UTF8.GetBytes($app.MainModule.FileName.ToUpperInvariant())
            $group = 'GarlicTransfer.Helper.v1.' + [BitConverter]::ToString($sha.ComputeHash($pathBytes)).Replace('-', '')
        } finally { $sha.Dispose() }

        # Remove rules left by interrupted workers for this installation.
        Get-NetFirewallRule -PolicyStore PersistentStore -Name 'GarlicNetwork-*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Group -eq $group -and $_.Name -match '^GarlicNetwork-(\d+)-(\d+)-(TCP|UDP)$' } |
            ForEach-Object {
                $parts = $_.Name.Split('-')
                $owner = Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue
                $ownerStart = if ($owner) { $owner.StartTime }
                if (!$owner -or ($ownerStart -and $ownerStart.ToUniversalTime().Ticks -ne [long]$parts[2])) {
                    $_ | Remove-NetFirewallRule
                }
            }

        $workerStart = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks
        $ports = @{ TCP = @('1004', '1005'); UDP = @('1006') }
        foreach ($protocol in @('TCP', 'UDP')) {
            $name = "GarlicNetwork-$PID-$workerStart-$protocol"
            $rules += New-NetFirewallRule -PolicyStore PersistentStore -Name $name -Group $group `
                -DisplayName "GarlicTransfer temporary access ($protocol)" -Protocol $protocol `
                -Direction Inbound -Action Allow -Enabled True -Profile Any -LocalPort $ports[$protocol] `
                -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block
        }
        [void]$ready.Set()
        while (!$app.WaitForExit(2000) -and !$supervisor.HasExited) {}
        $result = 0
    } catch {
        $result = 1
    } finally {
        foreach ($rule in $rules) {
            try { $rule | Remove-NetFirewallRule -ErrorAction Stop } catch { $result = 1 }
        }
        if ($supervisor) { $supervisor.Dispose() }
        if ($ready) { $ready.Dispose() }
        if ($app) { $app.Dispose() }
    }
    exit $result
}

try {
    $app = [Diagnostics.Process]::GetProcessById($appProcessId)
    $appStart = $app.StartTime.ToUniversalTime().Ticks
    $eventName = 'Local\GarlicFirewall-' + [Guid]::NewGuid().ToString('N')
    $acl = [Security.AccessControl.EventWaitHandleSecurity]::new()
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $admins = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
    $acl.AddAccessRule([Security.AccessControl.EventWaitHandleAccessRule]::new($owner, 'FullControl', 'Allow'))
    $acl.AddAccessRule([Security.AccessControl.EventWaitHandleAccessRule]::new($admins, 'Modify', 'Allow'))
    $created = $false
    $event = [Threading.EventWaitHandle]::new($false, 'ManualReset', $eventName, [ref]$created, $acl)
    if (!$created) { throw 'Could not create the firewall readiness event.' }
    $command = "& {" + $firewallWorker.ToString() + "} $appProcessId $appStart $PID '$eventName'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $PSHOME `
        -Verb RunAs -WindowStyle Hidden -PassThru `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (!$event.WaitOne(250)) {
        if ($worker.HasExited) { throw 'Windows could not create the temporary firewall rules.' }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for Windows firewall access.' }
    }
    [Console]::Out.WriteLine('READY')
    $worker.WaitForExit()
    exit $worker.ExitCode
} catch {
    $errorDetail = $_.Exception.GetBaseException()
    if ($errorDetail -is [ComponentModel.Win32Exception] -and $errorDetail.NativeErrorCode -eq 1223) {
        [Console]::Error.WriteLine('Windows administrator approval was cancelled.')
    } else {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
    exit 1
} finally {
    if ($event) { $event.Dispose() }
    if ($worker) { $worker.Dispose() }
    if ($app) { $app.Dispose() }
}
