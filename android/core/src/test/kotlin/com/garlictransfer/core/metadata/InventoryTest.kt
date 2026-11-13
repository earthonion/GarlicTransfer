package com.garlictransfer.core.metadata

import com.garlictransfer.core.ConsoleUser
import com.garlictransfer.core.EntryKind
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class InventoryTest {

    @TempDir
    lateinit var root: File

    private fun inventoryDb(): File {
        val path = File(root, "metadata.db")
        withDb(path) { db ->
            db.exec("CREATE TABLE dir_entry_info_tbl (id, path, actual_size, target_type)")
            val rows = listOf(
                InventoryRow4(1, "/system_data/priv/cache/profile/0x18C60EA2/", 475760, 0),
                InventoryRow4(349, "/user/app/PPSA98513/", 43763, 1),
                InventoryRow4(348, "/user/app/PPSA98513/sce_sys/", 16633876, 1),
                InventoryRow4(122, "/user/home/18c60ea2/savedata_prospero/PPSA21564/", 20971520, 3),
                InventoryRow4(87, "/user/av_contents/", 1056720102, 2),
                InventoryRow4(5, "/system_data/priv/appmeta/NPXS40074/", 160, 1),
                InventoryRow4(205, "/user/playgo/app/IV0005-PPSA01385_00-DIAGQAINSPECTION/00/", 2156, 1),
            )
            for (row in rows) {
                db.update(
                    "INSERT INTO dir_entry_info_tbl VALUES (?, ?, ?, ?)",
                    row.id, row.path, row.size, row.targetType,
                )
            }
            db.exec("CREATE TABLE user_info_tbl (user_id, user_name, login_id, online_id)")
            db.update("INSERT INTO user_info_tbl VALUES (415633058, 'tester', 'tester@example.invalid', 'tester')")
        }
        return path
    }

    private data class InventoryRow4(val id: Long, val path: String, val size: Long, val targetType: Long)

    @Test
    fun `all entry types are categorized`() {
        val (entries, users) = withDb(inventoryDb()) { db -> Metadata.readInventory(db, setOf(122)) }
        assertEquals(listOf(1L, 5L, 87L, 122L, 205L, 348L, 349L), entries.map { it.id })
        val byId = entries.associateBy { it.id }
        assertEquals(EntryKind.PROFILE, byId.getValue(1).kind)
        assertEquals(EntryKind.OTHER, byId.getValue(5).kind)
        assertEquals(EntryKind.MEDIA, byId.getValue(87).kind)
        assertEquals(EntryKind.SAVE, byId.getValue(122).kind)
        assertEquals("18c60ea2", byId.getValue(122).owner)
        assertEquals("PPSA21564", byId.getValue(122).title)
        assertTrue(byId.getValue(122).downloaded)
        assertEquals(EntryKind.OTHER, byId.getValue(205).kind)
        assertEquals(EntryKind.APP, byId.getValue(348).kind)
        assertEquals(EntryKind.APP, byId.getValue(349).kind)
        assertEquals("console", byId.getValue(349).owner)
        assertEquals(43763L, byId.getValue(349).size)
        assertFalse(byId.getValue(349).downloaded)
        assertEquals(listOf(ConsoleUser("18c60ea2", "tester")), users)
    }

    @Test
    fun `readUsers falls back through the name columns`() {
        val path = File(root, "users.db")
        val users = withDb(path) { db ->
            db.exec("CREATE TABLE user_info_tbl (user_id, user_name, login_id, online_id)")
            db.update("INSERT INTO user_info_tbl VALUES (?, ?, ?, ?)", 1L, "", "login@example.invalid", null)
            db.update("INSERT INTO user_info_tbl VALUES (?, ?, ?, ?)", 2L, null, null, "online-name")
            db.update("INSERT INTO user_info_tbl VALUES (?, ?, ?, ?)", 3L, null, null, null)
            Metadata.readUsers(db)
        }
        val byId = users.associateBy { it.id }
        assertEquals("login@example.invalid", byId.getValue("00000001").name)
        assertEquals("online-name", byId.getValue("00000002").name)
        assertEquals("00000003", byId.getValue("00000003").name)
    }
}
