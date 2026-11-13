package com.garlictransfer.core.metadata

import java.io.File

/** Minimal SQLite surface so the metadata engine runs on both JDBC (JVM/tests) and android.database.sqlite. */
interface SqlRow {
    fun getString(index: Int): String?
    fun getLong(index: Int): Long
    fun getInt(index: Int): Int = getLong(index).toInt()
    fun isNull(index: Int): Boolean = getString(index) == null
}

interface SqlDb : AutoCloseable {
    fun exec(sql: String)
    fun update(sql: String, vararg args: Any?): Int
    fun <T> query(sql: String, vararg args: Any?, mapper: (SqlRow) -> T): List<T>
    override fun close()

    fun <T> queryOne(sql: String, vararg args: Any?, mapper: (SqlRow) -> T): T? = query(sql, *args, mapper = mapper).firstOrNull()
}

fun interface SqlDbFactory {
    fun open(path: File): SqlDb
}
