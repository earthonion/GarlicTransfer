package com.garlictransfer.core.source

import com.garlictransfer.core.metadata.SqlDb
import com.garlictransfer.core.metadata.SqlDbFactory
import com.garlictransfer.core.metadata.SqlRow
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet

private class JdbcSqlRow(private val rs: ResultSet) : SqlRow {
    override fun getString(index: Int): String? = rs.getString(index + 1)
    override fun getLong(index: Int): Long = rs.getLong(index + 1)
}

private class JdbcSqlDb(private val connection: Connection) : SqlDb {
    override fun exec(sql: String) {
        connection.createStatement().use { it.execute(sql) }
    }

    override fun update(sql: String, vararg args: Any?): Int =
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            statement.executeUpdate()
        }

    override fun <T> query(sql: String, vararg args: Any?, mapper: (SqlRow) -> T): List<T> =
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            val rs = statement.executeQuery()
            val row = JdbcSqlRow(rs)
            val out = ArrayList<T>()
            while (rs.next()) out += mapper(row)
            out
        }

    override fun close() = connection.close()

    private fun bind(statement: PreparedStatement, args: Array<out Any?>) {
        args.forEachIndexed { index, arg -> statement.setObject(index + 1, arg) }
    }
}

fun jdbcSqlDbFactory(): SqlDbFactory {
    Class.forName("org.sqlite.JDBC")
    return SqlDbFactory { file ->
        JdbcSqlDb(DriverManager.getConnection("jdbc:sqlite:" + file.absolutePath))
    }
}
