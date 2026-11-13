package com.garlictransfer.android.db

import android.database.sqlite.SQLiteDatabase
import com.garlictransfer.core.metadata.SqlDb
import com.garlictransfer.core.metadata.SqlDbFactory
import com.garlictransfer.core.metadata.SqlRow
import java.io.File

private class AndroidSqlRow(private val cursor: android.database.Cursor) : SqlRow {
    override fun getString(index: Int): String? = if (cursor.isNull(index)) null else cursor.getString(index)
    override fun getLong(index: Int): Long = cursor.getLong(index)
    override fun isNull(index: Int): Boolean = cursor.isNull(index)
}

class AndroidSqlDb(private val db: SQLiteDatabase) : SqlDb {

    override fun exec(sql: String) = db.execSQL(sql)

    override fun update(sql: String, vararg args: Any?): Int =
        db.compileStatement(sql).use { statement ->
            args.forEachIndexed { i, value ->
                val index = i + 1
                when (value) {
                    null -> statement.bindNull(index)
                    is String -> statement.bindString(index, value)
                    is Long -> statement.bindLong(index, value)
                    is Int -> statement.bindLong(index, value.toLong())
                    is ByteArray -> statement.bindBlob(index, value)
                    else -> statement.bindString(index, value.toString())
                }
            }
            statement.executeUpdateDelete()
        }

    override fun <T> query(sql: String, vararg args: Any?, mapper: (SqlRow) -> T): List<T> {
        val stringArgs = args.map { arg ->
            when (arg) {
                null -> null
                is String -> arg
                is Long -> arg.toString()
                is Int -> arg.toString()
                else -> arg.toString()
            }
        }.toTypedArray()
        val out = ArrayList<T>()
        db.rawQuery(sql, stringArgs).use { cursor ->
            val row = AndroidSqlRow(cursor)
            while (cursor.moveToNext()) out.add(mapper(row))
        }
        return out
    }

    override fun close() = db.close()
}

object AndroidSqlDbFactory : SqlDbFactory {
    override fun open(path: File): SqlDb =
        AndroidSqlDb(SQLiteDatabase.openDatabase(path.absolutePath, null, SQLiteDatabase.OPEN_READWRITE))
}
