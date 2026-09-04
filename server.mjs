// chat-ui 生产入口。
//
// 背景 1：adapter-node 的产物不会自己加载 .env/.env.local——那只在 dev 模式和
// 构建期（PUBLIC_* 变量）生效。缺了 .env 的默认值会出现难懂的报错，例如
// COOKIE_NAME 为空导致 cookies.set() 抛 "argument name is invalid"。
// dotenv 默认不覆盖已存在变量，所以先 .env.local 后 .env，local 优先。
//
// 背景 2：纯 HTTP 内网部署必须显式声明 ORIGIN。adapter-node 用它做 CSRF
// origin 校验；不设时会从 Host 头推断协议，实测推断成了 https://，
// 前端资源随即 ERR_SSL_PROTOCOL_ERROR，POST 建会话返回 500。
// 真实对外地址放在 .env.local 的 PUBLIC_ORIGIN（不入库），这里只留
// 一个能让本机自测跑通的兜底值。
import dotenv from "dotenv";

dotenv.config({ path: "/opt/chat-ui/.env.local" });
dotenv.config({ path: "/opt/chat-ui/.env" });

process.env.HOST ||= "0.0.0.0";
// 标准 HTTP 端口，访问时不用再带 :3000。绑 80 需要 root 或
// CAP_NET_BIND_SERVICE —— systemd 单元里是 User=root，已满足。
process.env.PORT ||= "80";
process.env.ORIGIN ||=
	process.env.PUBLIC_ORIGIN ||
	`http://localhost${process.env.PORT === "80" ? "" : ":" + process.env.PORT}`;
// 附件是 base64 装在 multipart 里的（见 conversation/[id]/+server.ts，
// 文件名前缀就是 "base64;"），所以线上体积约为原始的 4/3：单文件上限
// PUBLIC_MAX_UPLOAD_MB=50（视频）就是 67MB，再加同一轮的图片和文档，
// 留一倍余量。仅内网可访问，放宽的风险可控。
process.env.BODY_SIZE_LIMIT ||= "209715200"; // 200MB

for (const k of [
	"OPENAI_BASE_URL",
	"MONGODB_URL",
	"COOKIE_NAME",
	"COOKIE_SECURE",
	"COOKIE_SAMESITE",
	"ORIGIN",
	"PUBLIC_ORIGIN",
]) {
	console.log(`[boot] ${k.padEnd(16)}= ${process.env[k]}`);
}
console.log("[boot] listening on", process.env.HOST + ":" + process.env.PORT);

await import("/opt/chat-ui/build/index.js");
