param(
    [ipaddress]$ConsoleAddress,
    [uint32]$ExpectedIndex,
    [guid]$ExpectedGuid = [guid]::Empty,
    [switch]$Enable
)

if ($Enable) { $env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules') }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $route = Find-NetRoute -RemoteIPAddress $ConsoleAddress.IPAddressToString | Select-Object -First 1
    if (!$route) { throw 'Windows could not find a route to the selected PS5.' }
    $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex
    if ($Enable -and ($adapter.ifIndex -ne $ExpectedIndex -or [guid]$adapter.InterfaceGuid -ne $ExpectedGuid)) {
        exit 20
    }

    $name = [Management.Automation.WildcardPattern]::Escape($adapter.Name)
    $binding = @(Get-NetAdapterBinding -Name $name -ComponentID ms_tcpip6 |
        Where-Object { $_.Name -eq $adapter.Name })
    if ($binding.Count -ne 1) { throw 'Windows could not identify the IPv6 binding on this adapter.' }

    if ($Enable) {
        if (!$binding[0].Enabled) { Enable-NetAdapterBinding -InputObject $binding[0] -Confirm:$false }
        exit 0
    }

    $profile = Get-NetConnectionProfile -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $category = if ($profile) { [string]$profile.NetworkCategory } else { 'Unknown' }
    $linkLocal = if ($binding[0].Enabled) {
        Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6 -AddressState Preferred -ErrorAction SilentlyContinue |
            Where-Object { ([ipaddress]$_.IPAddress).IsIPv6LinkLocal } |
            Select-Object -ExpandProperty IPAddress -First 1
    }
    [ordered]@{
        interfaceIndex = [uint32]$adapter.ifIndex
        interfaceGuid = ([guid]$adapter.InterfaceGuid).ToString()
        interfaceAlias = [string]$adapter.Name
        profile = $category
        ipv6Enabled = [bool]$binding[0].Enabled
        linkLocalAddress = [string]$linkLocal
    } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
