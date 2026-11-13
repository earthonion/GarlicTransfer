package com.garlictransfer.android.session

import android.content.Context
import java.io.File

object Profiles {
    fun root(context: Context): File = File(context.applicationContext.filesDir, "profiles")

    fun dir(context: Context, hostId: String): File = File(root(context), hostId)

    /** Host IDs of profiles that hold a downloaded metadata.db. */
    fun available(context: Context): List<String> =
        root(context).listFiles()
            ?.filter { it.isDirectory && File(it, "metadata.db").isFile }
            ?.map { it.name }
            ?.sorted()
            ?: emptyList()

    fun metadata(context: Context, hostId: String): File = File(dir(context, hostId), "metadata.db")

    fun pairingPrefix(context: Context, hostId: String, systemVersion: String): File =
        File(
            context.applicationContext.filesDir,
            "pairings/${hostId.uppercase()}-${systemVersion.uppercase()}/pairing-prefix.bin",
        )
}
