/**
 * chat-ui 数据清理。
 *
 * 背景：chat-ui 只给临时集合建了 TTL 索引（generationEvents 24h、
 * generations/turnStates 7d 等），但 conversations / settings /
 * conversations.stats / GridFS(files.*) 没有任何过期机制。
 * 无认证部署下每个新浏览器 = 新 sessionId = 一批新记录，会无限累积。
 *
 * 单纯给 conversations 加 TTL 索引不够：删了会话，GridFS 里的图片
 * 会变成孤儿永远留着，而那是占空间最大的部分。所以用脚本统一处理。
 *
 * 用法:
 *   node cleanup_chatui.mjs            只报告，不删除（默认）
 *   node cleanup_chatui.mjs --apply    实际删除
 *   RETENTION_DAYS=7 node cleanup_chatui.mjs --apply
 */
import { MongoClient, ObjectId } from "mongodb";

const URL = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017";
const DB = process.env.MONGODB_DB_NAME || "chat-ui";
// guest 用途，不保留数据。用小时级保留而不是「全清」：
// 全清会在 guest 聊到一半时把他的对话抹掉；留一个小窗口即可，
// 配合高频执行，数据库实际上始终接近空。
const HOURS = process.env.RETENTION_HOURS
  ? Number(process.env.RETENTION_HOURS)
  : Number(process.env.RETENTION_DAYS || 1) * 24;
const APPLY = process.argv.includes("--apply");

const cutoff = new Date(Date.now() - HOURS * 60 * 60 * 1000);

const client = new MongoClient(URL);
await client.connect();
const db = client.db(DB);

console.log(`模式: ${APPLY ? "实际删除" : "仅报告（加 --apply 才会删）"}`);
console.log(`保留期: ${HOURS} 小时  → 删除 ${cutoff.toISOString()} 之前的数据\n`);

// 1) 过期会话
const oldConvs = await db
  .collection("conversations")
  .find({ updatedAt: { $lt: cutoff } }, { projection: { _id: 1 } })
  .toArray();
const oldIds = oldConvs.map((c) => c._id.toString());
console.log(`conversations        过期 ${oldIds.length} / 共 ${await db.collection("conversations").countDocuments()}`);

// 2) GridFS：文件名前缀是 conversation id。
//    既清过期会话的文件，也清没有任何会话对应的孤儿文件。
const allConvIds = new Set(
  (await db.collection("conversations").find({}, { projection: { _id: 1 } }).toArray())
    .map((c) => c._id.toString())
);
const files = await db.collection("files.files").find({}).toArray();
const doomedFiles = files.filter((f) => {
  const owner = String(f.filename || "").split("-")[0];
  return oldIds.includes(owner) || !allConvIds.has(owner);
});
const doomedBytes = doomedFiles.reduce((a, f) => a + (f.length || 0), 0);
console.log(`files (GridFS)       待删 ${doomedFiles.length} / 共 ${files.length}  (${(doomedBytes / 1024).toFixed(0)} KB)`);

// 3) settings：sessionId 已无任何会话，且自身也过期
const liveSessions = new Set(
  (await db.collection("conversations").distinct("sessionId")).filter(Boolean)
);
const oldSettings = await db
  .collection("settings")
  .find({ updatedAt: { $lt: cutoff } }, { projection: { _id: 1, sessionId: 1 } })
  .toArray();
const doomedSettings = oldSettings.filter((s) => !liveSessions.has(s.sessionId));
console.log(`settings             待删 ${doomedSettings.length} / 共 ${await db.collection("settings").countDocuments()}`);

// 4) 每日统计
const oldStats = await db.collection("conversations.stats").countDocuments({
  "date.at": { $lt: cutoff },
});
console.log(`conversations.stats  过期 ${oldStats} / 共 ${await db.collection("conversations.stats").countDocuments()}`);

if (!APPLY) {
  console.log("\n未做任何修改。确认无误后加 --apply 执行。");
  await client.close();
  process.exit(0);
}

console.log("\n执行删除 ...");
for (const f of doomedFiles) {
  await db.collection("files.chunks").deleteMany({ files_id: f._id });
  await db.collection("files.files").deleteOne({ _id: f._id });
}
console.log(`  GridFS 已删 ${doomedFiles.length} 个文件`);

const rc = await db
  .collection("conversations")
  .deleteMany({ _id: { $in: oldConvs.map((c) => c._id) } });
console.log(`  conversations 已删 ${rc.deletedCount}`);

const rs = await db
  .collection("settings")
  .deleteMany({ _id: { $in: doomedSettings.map((s) => s._id) } });
console.log(`  settings 已删 ${rs.deletedCount}`);

const rst = await db
  .collection("conversations.stats")
  .deleteMany({ "date.at": { $lt: cutoff } });
console.log(`  conversations.stats 已删 ${rst.deletedCount}`);

await client.close();
console.log("完成。");
