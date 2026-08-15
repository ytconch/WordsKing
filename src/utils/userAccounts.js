const { clientDb, serverDb } = require("../db/connections");

async function countAdmins() {
  const row = await clientDb.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
  return row?.count || 0;
}

async function deleteUserAccount(userId) {
  let serverTransactionStarted = false;
  let clientTransactionStarted = false;

  try {
    await serverDb.exec("BEGIN TRANSACTION");
    serverTransactionStarted = true;
    await clientDb.exec("BEGIN TRANSACTION");
    clientTransactionStarted = true;

    await serverDb.run("DELETE FROM practice_sessions WHERE user_id = ?", [userId]);
    await serverDb.run("UPDATE import_batches SET created_by = NULL WHERE created_by = ?", [userId]);
    await clientDb.run("DELETE FROM users WHERE id = ?", [userId]);
    await serverDb.exec("COMMIT");
    serverTransactionStarted = false;
    await clientDb.exec("COMMIT");
    clientTransactionStarted = false;
  } catch (error) {
    if (serverTransactionStarted) {
      await serverDb.exec("ROLLBACK");
    }
    if (clientTransactionStarted) {
      await clientDb.exec("ROLLBACK");
    }
    throw error;
  }
}

module.exports = {
  countAdmins,
  deleteUserAccount
};
