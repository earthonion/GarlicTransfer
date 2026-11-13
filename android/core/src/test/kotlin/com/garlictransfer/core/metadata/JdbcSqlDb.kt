package com.garlictransfer.core.metadata

import java.io.File
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.Types

/** JDBC-backed [SqlDb] for JVM tests; production binds the same interface to android.database.sqlite. */
class JdbcSqlDb private constructor(private val connection: Connection) : SqlDb {

    override fun exec(sql: String) {
        val statement = connection.createStatement()
        try {
            statement.execute(sql)
        } finally {
            statement.close()
        }
    }

    override fun update(sql: String, vararg args: Any?): Int {
        val statement = prepare(sql, *args)
        try {
            return statement.executeUpdate()
        } finally {
            statement.close()
        }
    }

    override fun <T> query(sql: String, vararg args: Any?, mapper: (SqlRow) -> T): List<T> {
        val statement = prepare(sql, *args)
        try {
            val result = statement.executeQuery()
            try {
                val row = JdbcSqlRow(result)
                val rows = ArrayList<T>()
                while (result.next()) rows.add(mapper(row))
                return rows
            } finally {
                result.close()
            }
        } finally {
            statement.close()
        }
    }

    override fun close() {
        connection.close()
    }

    private fun prepare(sql: String, vararg args: Any?): PreparedStatement {
        val statement = connection.prepareStatement(sql)
        for ((index, value) in args.withIndex()) {
            when (value) {
                null -> statement.setNull(index + 1, Types.NULL)
                is String -> statement.setString(index + 1, value)
                is Long -> statement.setLong(index + 1, value)
                is Int -> statement.setInt(index + 1, value)
                is ByteArray -> statement.setBytes(index + 1, value)
                is Boolean -> statement.setInt(index + 1, if (value) 1 else 0)
                else -> throw IllegalArgumentException("unsupported SQL bind type: ${value.javaClass.name}")
            }
        }
        return statement
    }

    private class JdbcSqlRow(private val result: ResultSet) : SqlRow {
        override fun getString(index: Int): String? = result.getString(index + 1)
        override fun getLong(index: Int): Long = result.getLong(index + 1)
    }

    companion object {
        init {
            Class.forName("org.sqlite.JDBC")
        }

        val Factory: SqlDbFactory = SqlDbFactory { path -> open(path) }

        fun open(path: File): JdbcSqlDb =
            JdbcSqlDb(DriverManager.getConnection("jdbc:sqlite:${path.absolutePath}"))
    }
}

internal fun <T> withDb(path: File, block: (JdbcSqlDb) -> T): T {
    val db = JdbcSqlDb.open(path)
    try {
        return block(db)
    } finally {
        db.close()
    }
}
