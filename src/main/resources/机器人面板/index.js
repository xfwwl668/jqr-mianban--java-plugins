/**
 * ============================================================
 * 项目名称：Pathfinder PRO (2025 最终美化版 + 双应用中心)
 * 核心增强：拟人词库、错别字模拟、智能回嘴、进服宣言
 * 应用中心：火狐浏览器(支持自定义配置)、音乐加速(Bash原生)
 * 机器人增强：翼龙守护进程 (每3分钟自动检测开机)
 * ============================================================
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const mineflayer = require("mineflayer");
const express = require("express");
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const activeBots = new Map();
const CONFIG_FILE = path.join(__dirname, 'bots_config.json');
const mcDataCache = new Map(); 

const FF_DIR = path.join(__dirname, 'node_modules', '.fire');
const MUSIC_DIR = path.join(__dirname, 'node_modules', '.music_accelerator');

let ffLiteProcess = null, cfTunnelProcess = null, cfTunnelUrl = '', ffLogs = [];
let musicProcess = null, musicLogs = [];

app.use(express.json());

// --- [ 1. 拟人化深度词库矩阵 ] ---
const CHAT_DB = { idle: ["有人吗", "2333", "啧", "挂机中", "emm", "好无聊啊", "这服人怎么这么少", "有点卡啊", "这延迟绝了", "我先挂会机", "刷点东西真累", "有人带带萌新吗", "woc刚才那个怪", "有人在不", "又是努力挂机的一天", "这天气不错", "有人聊天吗", "刚才卡了一下", "我去倒杯水", "先眯一会", "草（一种植物）", "害"], interaction: ["？", "你说啥", "没注意看", "哦哦", "搜嘎", "确实", "我也是这么想的", "哈哈哈哈", "666", "强啊大佬", "nb", "可以的", "羡慕了", "别cue我", "在呢"], suffixes: ["~", "...", "捏", "哈", "呀", "！", "？", "w"], typos: { "挂机": ["刮机", "挂机机"], "有人": ["友谊", "有仁"], "怎么": ["咋"], "没有": ["木有"] } };
function generateNaturalChat(type = 'idle') { let pool = CHAT_DB[type]; let msg = pool[Math.floor(Math.random() * pool.length)]; if (Math.random() > 0.9) { for (let key in CHAT_DB.typos) { if (msg.includes(key)) { msg = msg.replace(key, CHAT_DB.typos[key][Math.floor(Math.random() * CHAT_DB.typos[key].length)]); break; } } } if (Math.random() > 0.7) msg += CHAT_DB.suffixes[Math.floor(Math.random() * CHAT_DB.suffixes.length)]; if (Math.random() > 0.8) msg = (Math.random() > 0.5 ? " " : "") + msg + (Math.random() > 0.5 ? " " : ""); return msg; }

// --- [ 2. 内存监控与自愈逻辑 ] ---
function getMemoryStatus() { const used = process.memoryUsage().rss; let total = os.totalmem(); if (process.env.SERVER_MEMORY) { total = parseInt(process.env.SERVER_MEMORY) * 1024 * 1024; } else { try { if (fsSync.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) { const limit = parseInt(fsSync.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim()); if (limit < 9223372036854771712) total = limit; } else if (fsSync.existsSync('/sys/fs/cgroup/memory.max')) { const limit = fsSync.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(); if (limit !== 'max') total = parseInt(limit); } } catch (e) {} } const percent = ((used / total) * 100).toFixed(1); return { used: (used / 1024 / 1024).toFixed(1), total: (total / 1024 / 1024).toFixed(0), percent }; }
setInterval(() => { const status = getMemoryStatus(); if (parseFloat(status.percent) >= 80) { mcDataCache.clear(); activeBots.forEach(bot => { bot.logs = bot.logs.slice(0, 10); bot.pushLog(`⚠️ 内存占用 (${status.percent}%) 触发自愈`, 'text-red-400 font-bold'); }); if (parseFloat(status.percent) > 92) process.exit(1); } }, 30000);

// --- [ 3. 重启指令序列核心逻辑 ] ---
function executeRestartSequence(botInstance, botMeta) { if (!botInstance || !botInstance.entity) return; botInstance.chat('/restart'); botMeta.pushLog(`⚡ 重启序列(1/2): /restart`, 'text-red-400 font-bold'); setTimeout(() => { if (botInstance && botInstance.entity) { botInstance.chat('restart'); botMeta.pushLog(`⚡ 重启序列(2/2): restart`, 'text-red-500 font-bold'); } }, 800); botMeta.lastRestartTick = Date.now(); }

// --- [ 4. 核心持久化与机器人工厂 ] ---
async function saveBotsConfig() { try { const config = Array.from(activeBots.values()).map(b => ({ host: b.targetHost, port: b.targetPort, username: b.username, settings: b.settings, logs: b.logs.slice(0, 30) })); await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (err) {} }
async function createSmartBot(id, host, port, username, existingLogs = [], settings = null) { let finalHost = host.trim(), finalPort = parseInt(port) || 25565; if (finalHost.includes(':')) { const parts = finalHost.split(':'); finalHost = parts[0]; finalPort = parseInt(parts[1]) || 25565; } const defaultSettings = { walk: false, ai: true, chat: false, restartInterval: 0, pterodactyl: { url: '', key: '', id: '', defaultDir: '/', guard: false } }; const botMeta = { id, username, targetHost: finalHost, targetPort: finalPort, status: "连接中", logs: Array.isArray(existingLogs) ? existingLogs.slice(0, 30) : [], settings: settings || defaultSettings, instance: null, afkTimer: null, isRepairing: false, lastRestartTick: Date.now(), isMoving: false }; activeBots.set(id, botMeta); const pushLog = (msg, colorClass = '') => { const time = new Date().toLocaleTimeString('zh-CN', { hour12: false }); botMeta.logs.unshift({ time, msg, color: colorClass }); if (botMeta.logs.length > 30) botMeta.logs = botMeta.logs.slice(0, 30); }; botMeta.pushLog = pushLog; try { const bot = mineflayer.createBot({ host: finalHost, port: finalPort, username: username, auth: 'offline', hideErrors: true, physicsEnabled: botMeta.settings.walk, connectTimeout: 20000 }); bot.loadPlugin(pathfinder); botMeta.instance = bot; bot.once('spawn', () => { botMeta.status = "在线"; botMeta.centerPos = bot.entity.position.clone(); pushLog(`✅ 成功进入服务器`, 'text-emerald-400 font-bold'); let mcData; try { mcData = mcDataCache.get(bot.version) || require('minecraft-data')(bot.version); if (mcData) mcDataCache.set(bot.version, mcData); } catch (e) { pushLog(`❌ 协议不支持`, 'text-red-500'); return bot.end(); } const movements = new Movements(bot, mcData); movements.canDig = false; bot.pathfinder.setMovements(movements); setTimeout(() => { if (bot.entity) { bot.chat("诸君 我喜欢萝莉！"); pushLog(`📣 进服宣言: 诸君 我喜欢萝莉！`, 'text-purple-400 font-bold'); } }, 2000); bot.on('chat', (sender, message) => { if (sender === bot.username || !botMeta.settings.chat) return; const keys = ["机器人", "脚本", "挂机", bot.username, "有人", "在吗"]; if (keys.some(k => message.includes(k)) && Math.random() > 0.4) { setTimeout(() => { if (bot.entity) { const reply = generateNaturalChat('interaction'); bot.chat(reply); pushLog(`🗨️ 智能回嘴: [${sender}] -> ${reply}`, 'text-pink-400 font-bold'); } }, 1500 + Math.random() * 2000); } }); if (botMeta.afkTimer) clearInterval(botMeta.afkTimer); botMeta.afkTimer = setInterval(() => { if (!bot.entity) return; if (botMeta.settings.restartInterval > 0 && (Date.now() - botMeta.lastRestartTick) / 60000 >= botMeta.settings.restartInterval) executeRestartSequence(bot, botMeta); if (botMeta.settings.ai && !botMeta.isMoving) { const target = bot.nearestEntity(p => p.type === 'player'); if (target) bot.lookAt(target.position.offset(0, 1.6, 0)); } if (botMeta.settings.walk && !botMeta.isMoving && Math.random() > 0.7) { botMeta.isMoving = true; const targetPos = botMeta.centerPos.offset((Math.random()-0.5)*12, 0, (Math.random()-0.5)*12); pushLog(`👣 巡逻: 目标点 [${Math.round(targetPos.x)}, ${Math.round(targetPos.z)}]`, 'text-emerald-500'); bot.pathfinder.setGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1)); } if (botMeta.settings.chat && Math.random() > 0.92) { const m = generateNaturalChat('idle'); bot.chat(m); pushLog(`💬 拟人发话: ${m}`, 'text-orange-400'); } }, 8000); }); bot.on('goal_reached', () => { botMeta.isMoving = false; }); bot.once('end', () => attemptRepair(id, botMeta, "断开")); bot.on('error', (e) => attemptRepair(id, botMeta, e.code || "ERR")); } catch (err) { attemptRepair(id, botMeta, "失败"); } }
function attemptRepair(id, botMeta, reason) { if (!activeBots.has(id) || botMeta.isRepairing) return; botMeta.isRepairing = true; botMeta.status = "重连中"; if (botMeta.instance) { botMeta.instance.removeAllListeners(); try { botMeta.instance.end(); } catch(e) {} botMeta.instance = null; } if (botMeta.afkTimer) clearInterval(botMeta.afkTimer); setTimeout(() => { if (!activeBots.has(id)) return; botMeta.isRepairing = false; createSmartBot(id, botMeta.targetHost, botMeta.targetPort, botMeta.username, botMeta.logs, botMeta.settings); }, 10000); }

// --- [ 5. API 接口逻辑 - 机器人 ] ---
app.post("/api/bots/:id/restart-now", (req, res) => { const b = activeBots.get(req.params.id); if (b && b.instance) { executeRestartSequence(b.instance, b); res.json({ success: true }); } else res.status(404).json({ success: false }); });
app.post("/api/bots/:id/toggle", (req, res) => { const b = activeBots.get(req.params.id); if (b) { const type = req.body.type; b.settings[type] = !b.settings[type]; const statusText = b.settings[type] ? '开启' : '关闭'; const label = type === 'ai' ? '👁️ AI视角' : (type === 'walk' ? '👣 物理巡逻' : '💬 拟人喊话'); b.pushLog(`⚙️ 手动操作: ${label} 已${statusText}`, b.settings[type] ? 'text-blue-400' : 'text-slate-400'); if (type === 'walk' && b.instance) { b.instance.physicsEnabled = b.settings.walk; if (!b.settings.walk) { b.instance.pathfinder.setGoal(null); b.isMoving = false; } } saveBotsConfig(); res.json({ success: true }); } });
app.post("/api/bots/:id/upload", upload.single('file'), async (req, res) => { const b = activeBots.get(req.params.id); if (!b || !b.settings.pterodactyl.url || !req.file) return res.status(400).json({ success: false }); const { url, key, id, defaultDir } = b.settings.pterodactyl; b.pushLog(`🚀 同步文件: ${req.file.originalname} -> 翼龙`, 'text-blue-400 font-bold'); try { const getUrlResp = await axios.get(`${url}/api/client/servers/${id}/files/upload`, { headers: { 'Authorization': `Bearer ${key}` } }); const uploadUrl = getUrlResp.data.attributes.url; const form = new FormData(); form.append('files', req.file.buffer, req.file.originalname); await axios.post(`${uploadUrl}&directory=${encodeURIComponent(defaultDir)}`, form, { headers: { ...form.getHeaders() } }); b.pushLog(`✅ 翼龙文件同步成功`, 'text-emerald-400 font-bold'); res.json({ success: true }); } catch (err) { b.pushLog(`❌ 翼龙同步失败: ${err.message}`, 'text-red-500'); res.status(500).json({ success: false }); } });
app.get("/api/system/status", (req, res) => res.json(getMemoryStatus()));
app.get("/api/bots", (req, res) => res.json({ bots: Array.from(activeBots.values()).map(b => ({ id: b.id, username: b.username, host: b.targetHost, port: b.targetPort, status: b.status, logs: b.logs, settings: b.settings, nextRestart: b.settings.restartInterval > 0 ? new Date(b.lastRestartTick + b.settings.restartInterval * 60000).toLocaleTimeString() : '未开启' })) }));
app.post("/api/bots", (req, res) => { createSmartBot('bot_'+Math.random().toString(36).substr(2,7), req.body.host, 25565, req.body.username); res.json({ success: true }); });
app.post("/api/bots/:id/set-timer", (req, res) => { const b = activeBots.get(req.params.id); if (b) { const val = parseFloat(req.body.value) || 0; b.settings.restartInterval = req.body.unit === 'hour' ? Math.round(val * 60) : Math.round(val); b.lastRestartTick = Date.now(); b.pushLog(`⏰ 设定: 每 ${val}${req.body.unit==='hour'?'小时':'分钟'} 重启`, 'text-cyan-400 font-bold'); saveBotsConfig(); res.json({ success: true }); } });
app.post("/api/bots/:id/pto-config", (req, res) => { const b = activeBots.get(req.params.id); if (b) { b.settings.pterodactyl = { ...b.settings.pterodactyl, url: (req.body.url || "").replace(/\/$/, ""), key: req.body.key || "", id: req.body.id || "", defaultDir: req.body.defaultDir || '/' }; b.pushLog(`🔑 翼龙凭据已更新`, 'text-purple-400'); saveBotsConfig(); res.json({ success: true }); } });
app.post("/api/bots/:id/toggle-guard", (req, res) => { const b = activeBots.get(req.params.id); if (b) { b.settings.pterodactyl.guard = !b.settings.pterodactyl.guard; const status = b.settings.pterodactyl.guard ? '开启' : '关闭'; b.pushLog(`🛡️ 翼龙守护已${status}`, b.settings.pterodactyl.guard ? 'text-blue-400' : 'text-slate-400'); saveBotsConfig(); res.json({ success: true }); } });
app.delete("/api/bots/:id", (req, res) => { const b = activeBots.get(req.params.id); if (b) { if(b.afkTimer) clearInterval(b.afkTimer); if(b.instance) b.instance.end(); activeBots.delete(req.params.id); saveBotsConfig(); } res.json({ success: true }); });

// --- [ 6. 翼龙守护核心逻辑 ] ---
setInterval(async () => {
    for (const [id, botMeta] of activeBots.entries()) {
        if (botMeta.settings.pterodactyl.guard && botMeta.settings.pterodactyl.url && botMeta.settings.pterodactyl.key && botMeta.settings.pterodactyl.id) {
            try {
                const { url, key, id: sid } = botMeta.settings.pterodactyl;
                const r = await axios.get(`${url}/api/client/servers/${sid}/resources`, { headers: { 'Authorization': `Bearer ${key}` }, timeout: 5000 });
                const state = r.data.attributes.current_state;
                if (state !== 'running' && state !== 'starting') {
                    botMeta.pushLog(`🛡️ 守护触发: 服务器 [${state}], 正在发送开机指令...`, 'text-yellow-500 font-bold');
                    await axios.post(`${url}/api/client/servers/${sid}/power`, { signal: 'start' }, { headers: { 'Authorization': `Bearer ${key}` } });
                }
            } catch (err) {
                // 静默失败，避免刷屏
            }
        }
    }
}, 3 * 60 * 1000);

// --- [ 7. API 接口逻辑 - 应用中心 ] ---
function pushFFLog(msg, color = '') { const time = new Date().toLocaleTimeString('zh-CN', { hour12: false }); ffLogs.unshift({ time, msg, color }); if (ffLogs.length > 50) ffLogs = ffLogs.slice(0, 50); }
function pushMusicLog(msg, color = '') { const time = new Date().toLocaleTimeString('zh-CN', { hour12: false }); musicLogs.unshift({ time, msg, color }); if (musicLogs.length > 50) musicLogs = musicLogs.slice(0, 50); }
const execAsync = (cmd, opts) => new Promise((resolve, reject) => { exec(cmd, opts, (err, stdout, stderr) => { if (err) reject(err); else resolve({stdout, stderr}); }); });

app.get("/api/apps/firefox/status", (req, res) => res.json({ installed: fsSync.existsSync(FF_DIR), running: (ffLiteProcess !== null && !ffLiteProcess.killed) || (cfTunnelProcess !== null && !cfTunnelProcess.killed), url: cfTunnelUrl, logs: ffLogs }));
app.post("/api/apps/firefox/start", async (req, res) => {
    if (ffLiteProcess || cfTunnelProcess) return res.status(400).json({ success: false, msg: "运行中" });
    if (!fsSync.existsSync(FF_DIR)) fsSync.mkdirSync(FF_DIR, { recursive: true });
    const params = req.body.params || {};
    const FF_PASS = params.FF_PASS || '123456';
    const FF_PORT = params.FF_PORT || '25889';
    const ARGO_DOMAIN = params.ARGO_DOMAIN || '';
    const ARGO_AUTH = params.ARGO_AUTH || '';
    const env = { ...process.env, FF_PASS, FF_PORT };
    try {
        if (!fsSync.existsSync(path.join(FF_DIR, 'ff_lite.sh'))) { pushFFLog('⬇️ 下载 FF 脚本...', 'text-blue-400'); await execAsync('curl -sL -o ff_lite.sh https://gbjs.serv00.net/sh/ff_lite.sh && chmod +x ff_lite.sh', { cwd: FF_DIR, shell: '/bin/bash' }); }
        if (!fsSync.existsSync(path.join(FF_DIR, 'cloudflared'))) { pushFFLog('⬇️ 下载 CF 核心...', 'text-blue-400'); await execAsync('curl -sL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared', { cwd: FF_DIR, shell: '/bin/bash' }); }
        pushFFLog('🚀 启动 FF_Lite...', 'text-blue-400');
        ffLiteProcess = exec(`FF_PASS=${FF_PASS} FF_PORT=${FF_PORT} bash ff_lite.sh start`, { cwd: FF_DIR, env, shell: '/bin/bash' }, (err) => { if(err) pushFFLog(`❌ FF 异常`, 'text-red-500'); else pushFFLog('✅ FF 已启动', 'text-emerald-400'); });
        pushFFLog('🌐 构建 CF 隧道...', 'text-blue-400');
        let cfCmd = '';
        if (ARGO_AUTH && ARGO_DOMAIN) {
            if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
                cfCmd = `./cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
                pushFFLog('🔑 检测到固定隧道 Token，正在连接...', 'text-purple-400');
            } else {
                cfCmd = `./cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://localhost:${FF_PORT}`;
                pushFFLog('⚠️ ARGO_AUTH 格式不符，回退临时隧道', 'text-yellow-400');
            }
        } else {
            cfCmd = `./cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://localhost:${FF_PORT}`;
        }
        cfTunnelProcess = exec(cfCmd, { cwd: FF_DIR, env, shell: '/bin/bash' });
        cfTunnelProcess.stderr.on('data', (d) => {
            const m = d.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (m) { cfTunnelUrl = m[0]; pushFFLog(`✅ 隧道成功！`, 'text-emerald-400'); pushFFLog(`👉 ${cfTunnelUrl}`, 'text-yellow-400'); }
            const connMsg = d.toString().match(/Connection (.*) registered/);
            if(connMsg && ARGO_DOMAIN) { cfTunnelUrl = ARGO_DOMAIN; pushFFLog(`✅ 固定隧道已连接！`, 'text-emerald-400'); pushFFLog(`👉 ${cfTunnelUrl}`, 'text-yellow-400'); }
        });
        res.json({ success: true });
    } catch (err) { pushFFLog(`❌ 启动失败`, 'text-red-500'); res.status(500).json({ success: false }); }
});
app.post("/api/apps/firefox/stop", (req, res) => { pushFFLog('⏸️ 停止进程...', 'text-orange-400'); exec('pkill -f ff_lite.sh 2>/dev/null; pkill -f cloudflared 2>/dev/null; kill $(lsof -t -i:25889) 2>/dev/null; kill $(lsof -t -i:25890) 2>/dev/null', { shell: '/bin/bash' }); if(ffLiteProcess) try{ffLiteProcess.kill()}catch(e){}; if(cfTunnelProcess) try{cfTunnelProcess.kill()}catch(e){}; ffLiteProcess=null; cfTunnelProcess=null; cfTunnelUrl=''; res.json({ success: true }); });
app.delete("/api/apps/firefox/uninstall", async (req, res) => { exec('pkill -f ff_lite.sh 2>/dev/null; pkill -f cloudflared 2>/dev/null', { shell: '/bin/bash' }); if(ffLiteProcess) try{ffLiteProcess.kill()}catch(e){}; if(cfTunnelProcess) try{cfTunnelProcess.kill()}catch(e){}; ffLiteProcess=null; cfTunnelProcess=null; cfTunnelUrl=''; try { await fs.rm(FF_DIR, { recursive: true, force: true }); pushFFLog('🗑️ 已彻底清空火狐文件', 'text-red-400'); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); } });

// 音乐加速接口 (Bash 原生执行，彻底修复)
app.get("/api/apps/music/status", (req, res) => res.json({ installed: true, running: musicProcess !== null && !musicProcess.killed, logs: musicLogs }));
app.post("/api/apps/music/start", async (req, res) => {
    if (musicProcess && !musicProcess.killed) return res.status(400).json({ success: false, msg: "运行中" });
    if (!fsSync.existsSync(MUSIC_DIR)) fsSync.mkdirSync(MUSIC_DIR, { recursive: true });

    const params = req.body.params || {};
    
    // 继承完整环境变量
    const env = { 
        ...process.env,
        SERVER_PORT: '3001', 
        PORT: '3001', 
        FILE_PATH: path.join(MUSIC_DIR, '.tmp'),
        UPLOAD_URL: '', 
        PROJECT_URL: '', 
        AUTO_ACCESS: 'false'
    };
    
    // 写入用户自定义参数
    const keys = ['UUID', 'ARGO_DOMAIN', 'ARGO_AUTH', 'ARGO_PORT', 'NEZHA_SERVER', 'NEZHA_PORT', 'NEZHA_KEY', 'CFIP', 'CFPORT', 'NAME'];
    keys.forEach(k => { if(params[k]) env[k] = params[k]; });

    // ✅ 终极修复：伪造 wget 命令，用 curl 代理执行，完美绕过环境无 wget 的问题
    const fakeWgetPath = path.join(MUSIC_DIR, 'wget');
    if (!fsSync.existsSync(fakeWgetPath)) {
        pushMusicLog('🔧 注入 wget 替代模块 (基于 curl)...', 'text-blue-400');
        // 注意: 需要用 \$ 转义，防止 JS 误解析 Bash 的 ${} 变量
        const fakeWgetContent = `#!/bin/bash
args=(); url=""; output=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -O) output="\$2"; shift 2;;
    -O*) output="\${1#-O}"; shift;;
    -q|--quiet) args+=("-s"); shift;;
    *) url="\$1"; shift;;
  esac
done
if [ -n "\$output" ]; then
  curl -Ls "\${args[@]}" -o "\$output" "\$url"
else
  curl -Ls "\${args[@]}" -O "\$url"
fi`;
        fsSync.writeFileSync(fakeWgetPath, fakeWgetContent);
        fsSync.chmodSync(fakeWgetPath, 0o755);
        pushMusicLog('✅ wget 代理模块就绪', 'text-emerald-400');
    }
    
    // 将 MUSIC_DIR 插入 PATH 最前面，使脚本优先调用我们伪造的 wget
    env.PATH = `${MUSIC_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH || ''}`;

    pushMusicLog('🚀 启动音乐加速 (Bash 原生模式)...', 'text-blue-400');
    const cmd = 'bash <(curl -Ls https://main.ssss.nyc.mn/sb.sh)';
    
    musicProcess = spawn('bash', ['-c', cmd], { cwd: MUSIC_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    musicProcess.stdout.on('data', (d) => { d.toString().split('\n').forEach(l => { if(l.trim()) pushMusicLog(l, 'text-slate-300'); }); });
    musicProcess.stderr.on('data', (d) => { d.toString().split('\n').forEach(l => { if(l.trim()) pushMusicLog(l, 'text-yellow-400'); }); });
    musicProcess.on('close', (code) => { musicProcess = null; pushMusicLog(`⏹️ 进程已退出 (Code: ${code})`, 'text-orange-400'); });
    musicProcess.on('error', (err) => { pushMusicLog(`❌ 启动异常: ${err.message}`, 'text-red-500'); });
    
    res.json({ success: true });
});
app.post("/api/apps/music/stop", (req, res) => { pushMusicLog('⏸️ 停止进程...', 'text-orange-400'); if(musicProcess) try{musicProcess.kill()}catch(e){}; musicProcess=null; res.json({ success: true }); });
app.delete("/api/apps/music/uninstall", async (req, res) => { if(musicProcess) try{musicProcess.kill()}catch(e){}; musicProcess=null; try { await fs.rm(MUSIC_DIR, { recursive: true, force: true }); pushMusicLog('🗑️ 已彻底清空加速文件', 'text-red-400'); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); } });

// --- [ 8. 前端 UI 面板 ] ---
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pathfinder PRO 2025</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; background: #030712; color: #e2e8f0; background-image: radial-gradient(at 0% 0%, rgba(16, 185, 129, 0.08) 0px, transparent 50%), radial-gradient(at 100% 0%, rgba(59, 130, 246, 0.08) 0px, transparent 50%), radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.08) 0px, transparent 50%); min-height: 100vh; }
            .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2); }
            .card-hover { transition: all 0.3s ease; } .card-hover:hover { transform: translateY(-4px); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4); border-color: rgba(255, 255, 255, 0.15); }
            .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; } .online { background: #10b981; box-shadow: 0 0 8px #10b981; animation: pulse 2s infinite; } .offline { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
            .input-dark { background: rgba(2, 6, 23, 0.8); border: 1px solid rgba(255, 255, 255, 0.1); transition: all 0.2s; } .input-dark:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3); outline: none; }
            .btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3); transition: all 0.2s; } .btn-primary:hover { box-shadow: 0 6px 20px rgba(59, 130, 246, 0.5); transform: translateY(-1px); }
            .btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3); transition: all 0.2s; } .btn-danger:hover { box-shadow: 0 6px 20px rgba(239, 68, 68, 0.5); transform: translateY(-1px); }
            .log-box::-webkit-scrollbar { width: 4px; } .log-box::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 10px; } .log-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
            .toggle-btn { transition: all 0.2s ease; border: 1px solid transparent; } .toggle-btn:active { transform: scale(0.95); } .toggle-btn.off { background: rgba(30, 41, 59, 0.8); border-color: rgba(255,255,255,0.05); color: #94a3b8; } .toggle-btn.off:hover { background: rgba(51, 65, 85, 0.8); }
            details summary::-webkit-details-marker { display: none; }
            .modal-overlay { opacity: 0; pointer-events: none; transition: opacity 0.3s ease; } .modal-overlay.active { opacity: 1; pointer-events: auto; }
            .modal-content { transform: scale(0.95); transition: transform 0.3s ease; } .modal-overlay.active .modal-content { transform: scale(1); }
            .view-section { display: none; } .view-section.active-view { display: block; animation: fadeIn 0.2s ease; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        </style>
    </head>
    <body class="p-4 md:p-8 pb-24">
        <div class="max-w-7xl mx-auto">
            <header class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
                <div class="flex items-center gap-6">
                    <div><h1 class="text-4xl font-black bg-gradient-to-r from-blue-400 via-emerald-400 to-purple-400 bg-clip-text text-transparent uppercase tracking-tighter">Pathfinder PRO</h1><p class="text-slate-500 text-sm mt-1 font-medium tracking-wide">Minecraft 拟人挂机系统 v2025</p></div>
                    <button onclick="openAppCenter()" class="glass border border-white/10 px-5 py-2.5 rounded-2xl text-sm font-bold text-slate-300 hover:text-white hover:border-white/20 transition-all flex items-center gap-2 shadow-lg"><span class="text-lg">🚀</span> 应用中心</button>
                </div>
                <div class="glass p-2 rounded-2xl flex gap-2 w-full md:w-auto border border-white/10">
                    <input id="h" placeholder="IP:PORT" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white flex-1 md:w-48">
                    <input id="u" placeholder="角色名" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white md:w-36">
                    <button onclick="addBot()" class="btn-primary text-white px-6 py-2.5 rounded-xl text-sm font-bold active:scale-95">部署角色</button>
                </div>
            </header><div id="list" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"></div>
        </div>
        <div id="mem-bar" class="fixed bottom-6 right-6 p-4 glass rounded-2xl flex items-center gap-4 z-40 shadow-2xl border border-white/10"><div class="flex flex-col items-center justify-center"><span id="mem-percent" class="text-xl font-black text-white tracking-tight">0.0%</span><span class="text-[9px] font-bold text-slate-500 uppercase tracking-widest">RAM</span></div><div class="w-28 h-2 bg-slate-800 rounded-full overflow-hidden shadow-inner"><div id="mem-progress" class="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700 rounded-full" style="width: 0%"></div></div></div>
        <audio id="welcome-audio" preload="auto"><source src="https://raw.githubusercontent.com/outrzxy17145yy/-/main/welcome_voice.mp3" type="audio/mpeg"></audio>

        <div id="modal-app-center" class="modal-overlay fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div class="modal-content glass rounded-3xl w-full max-w-2xl border border-white/10 shadow-2xl p-8 relative max-h-[90vh] overflow-y-auto log-box">
                <div id="view-list" class="view-section active-view">
                    <div class="flex justify-between items-center mb-8"><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-3xl">🚀</span> 应用中心</h2><button onclick="closeAppCenter()" class="text-slate-400 hover:text-white text-2xl font-bold transition-colors">&times;</button></div>
                    <div class="grid grid-cols-2 gap-6">
                        <div onclick="showView('ff')" class="cursor-pointer glass rounded-2xl p-8 border border-orange-500/20 hover:border-orange-500/60 transition-all flex flex-col items-center justify-center gap-4 group"><div class="w-20 h-20 bg-orange-500/20 rounded-2xl flex items-center justify-center text-5xl shadow-inner group-hover:scale-110 transition-transform">🦊</div><h3 class="font-bold text-lg text-slate-200 group-hover:text-orange-300 transition-colors">火狐浏览器</h3><p class="text-xs text-slate-500 text-center">支持固定隧道/临时隧道</p></div>
                        <div onclick="showView('music')" class="cursor-pointer glass rounded-2xl p-8 border border-purple-500/20 hover:border-purple-500/60 transition-all flex flex-col items-center justify-center gap-4 group"><div class="w-20 h-20 bg-purple-500/20 rounded-2xl flex items-center justify-center text-5xl shadow-inner group-hover:scale-110 transition-transform">🎵</div><h3 class="font-bold text-lg text-slate-200 group-hover:text-purple-300 transition-colors">音乐加速</h3><p class="text-xs text-slate-500 text-center">VLESS/VMess 节点生成保活</p></div>
                    </div>
                </div>

                <div id="view-ff" class="view-section">
                    <div class="flex justify-between items-center mb-6"><div class="flex items-center gap-3"><button onclick="showView('list')" class="text-xl text-slate-400 hover:text-white transition-colors">←</button><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-3xl">🦊</span> 火狐浏览器</h2></div><button onclick="showView('list')" class="text-slate-400 hover:text-white text-2xl font-bold transition-colors">&times;</button></div>
                    <div class="bg-black/40 rounded-2xl p-5 border border-slate-800/50 flex flex-col gap-4">
                        <div class="space-y-2 p-4 bg-black/20 rounded-2xl border border-slate-800/50">
                            <p class="text-xs text-slate-400 font-bold mb-2">火狐配置 (留空使用默认值)</p>
                            <div class="grid grid-cols-2 gap-2"><input id="ff-argo-domain" placeholder="ARGO_DOMAIN (固定隧道域名)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="ff-argo-auth" placeholder="ARGO_AUTH (Token/Json)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
                            <div class="grid grid-cols-2 gap-2"><input id="ff-pass" placeholder="密码 (默认 123456)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="ff-port" placeholder="端口 (默认 25889)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
                        </div>
                        <div id="ff-url-box" class="hidden bg-cyan-500/10 border border-cyan-500/30 p-3 rounded-xl transition-all"><p class="text-[10px] text-cyan-400 font-bold mb-1">✅ CF隧道已就绪：</p><a id="ff-url-link" href="#" target="_blank" class="text-sm text-white font-mono underline break-all hover:text-cyan-300 transition-colors flex items-center gap-2"></a></div>
                        <div class="bg-black/60 rounded-xl p-3 h-48 overflow-y-auto font-mono text-[10px] border border-white/5 shadow-inner log-box" id="ff-log-box"><div class="text-slate-500 opacity-50 text-center mt-16">等待操作...</div></div>
                        <div class="grid grid-cols-3 gap-2">
                            <button onclick="startFF()" id="ff-btn-start" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold">▶️ 启动</button>
                            <button onclick="stopFF()" id="ff-btn-stop" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold">⏸️ 暂停</button>
                            <button onclick="uninstallFF()" id="ff-btn-uninstall" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold text-red-400">🗑️ 卸载</button>
                        </div>
                    </div>
                </div>

                <div id="view-music" class="view-section">
                    <div class="flex justify-between items-center mb-6"><div class="flex items-center gap-3"><button onclick="showView('list')" class="text-xl text-slate-400 hover:text-white transition-colors">←</button><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-3xl">🎵</span> 音乐加速</h2></div><button onclick="showView('list')" class="text-slate-400 hover:text-white text-2xl font-bold transition-colors">&times;</button></div>
                    <div class="bg-black/40 rounded-2xl p-5 border border-slate-800/50 flex flex-col gap-4">
                        <div class="space-y-2 p-4 bg-black/20 rounded-2xl border border-slate-800/50">
                            <p class="text-xs text-slate-400 font-bold mb-2">核心配置 (留空使用默认值)</p>
                            <input id="m-uuid" placeholder="UUID (默认随机)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">
                            <input id="m-argo-domain" placeholder="ARGO_DOMAIN (固定隧道域名)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">
                            <input id="m-argo-auth" placeholder="ARGO_AUTH (固定隧道Token/Json)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">
                            <div class="grid grid-cols-2 gap-2"><input id="m-nezha-server" placeholder="NEZHA_SERVER" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-nezha-key" placeholder="NEZHA_KEY" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
                            <div class="grid grid-cols-2 gap-2"><input id="m-cfip" placeholder="CFIP (默认 saas.sin.fan)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-cfport" placeholder="CFPORT (默认 443)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
                            <input id="m-name" placeholder="NAME (节点名称前缀)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">
                        </div>
                        <div class="bg-black/60 rounded-xl p-3 h-48 overflow-y-auto font-mono text-[10px] border border-white/5 shadow-inner log-box" id="music-log-box"><div class="text-slate-500 opacity-50 text-center mt-16">等待操作...</div></div>
                        <div class="grid grid-cols-3 gap-2">
                            <button onclick="startMusic()" id="music-btn-start" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold">▶️ 启动</button>
                            <button onclick="stopMusic()" id="music-btn-stop" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold">⏸️ 停止</button>
                            <button onclick="uninstallMusic()" id="music-btn-uninstall" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold text-red-400">🗑️ 卸载</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let drafts = {}; function saveDraft(botId, field, val) { if (!drafts[botId]) drafts[botId] = {}; drafts[botId][field] = val; } function getDraft(botId, field, fallback) { return (drafts[botId] && drafts[botId][field] !== undefined) ? drafts[botId][field] : (fallback || ''); }
            function showView(viewId) { document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view')); document.getElementById('view-' + viewId).classList.add('active-view'); if(viewId === 'ff') loadFFStatus(); if(viewId === 'music') loadMusicStatus(); }
            function openAppCenter() { document.getElementById('modal-app-center').classList.add('active'); showView('list'); }
            function closeAppCenter() { document.getElementById('modal-app-center').classList.remove('active'); }

            async function loadFFStatus() { try { const r = await fetch('/api/apps/firefox/status'); const d = await r.json(); const isRun = d.running; document.getElementById('ff-btn-start').className = \`toggle-btn \${isRun?'off opacity-50':'bg-emerald-600/90 shadow-lg shadow-emerald-500/30 text-white'} py-2.5 rounded-xl text-xs font-bold\`; document.getElementById('ff-btn-stop').className = \`toggle-btn \${isRun?'bg-orange-600/90 shadow-lg shadow-orange-500/30 text-white':'off opacity-50'} py-2.5 rounded-xl text-xs font-bold\`; if(d.url) { document.getElementById('ff-url-box').classList.remove('hidden'); document.getElementById('ff-url-link').href = d.url; document.getElementById('ff-url-link').innerHTML = \`🔗 \${d.url}\`; } else { document.getElementById('ff-url-box').classList.add('hidden'); } document.getElementById('ff-log-box').innerHTML = d.logs.length > 0 ? d.logs.map(l => \`<div class="mb-1 \${l.color} flex"><span class="opacity-30 mr-2 shrink-0 select-none">[\${l.time}]</span><span>\${l.msg}</span></div>\`).join('') : '<div class="text-slate-500 opacity-50 text-center mt-16">等待操作...</div>'; } catch(e){} }
            async function startFF() { const params = { FF_PASS: document.getElementById('ff-pass').value, FF_PORT: document.getElementById('ff-port').value, ARGO_DOMAIN: document.getElementById('ff-argo-domain').value, ARGO_AUTH: document.getElementById('ff-argo-auth').value }; await fetch('/api/apps/firefox/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ params }) }); loadFFStatus(); }
            async function stopFF() { await fetch('/api/apps/firefox/stop', { method: 'POST' }); loadFFStatus(); }
            async function uninstallFF() { if(!confirm('确认卸载？将清除所有下载的文件！')) return; await fetch('/api/apps/firefox/uninstall', { method: 'DELETE' }); loadFFStatus(); }

            async function loadMusicStatus() { try { const r = await fetch('/api/apps/music/status'); const d = await r.json(); const isRun = d.running; document.getElementById('music-btn-start').className = \`toggle-btn \${isRun?'off opacity-50':'bg-emerald-600/90 shadow-lg shadow-emerald-500/30 text-white'} py-2.5 rounded-xl text-xs font-bold\`; document.getElementById('music-btn-stop').className = \`toggle-btn \${isRun?'bg-orange-600/90 shadow-lg shadow-orange-500/30 text-white':'off opacity-50'} py-2.5 rounded-xl text-xs font-bold\`; document.getElementById('music-log-box').innerHTML = d.logs.length > 0 ? d.logs.map(l => \`<div class="mb-1 \${l.color} flex"><span class="opacity-30 mr-2 shrink-0 select-none">[\${l.time}]</span><span>\${l.msg}</span></div>\`).join('') : '<div class="text-slate-500 opacity-50 text-center mt-16">等待操作...</div>'; } catch(e){} }
            async function startMusic() { const params = { UUID: document.getElementById('m-uuid').value, ARGO_DOMAIN: document.getElementById('m-argo-domain').value, ARGO_AUTH: document.getElementById('m-argo-auth').value, NEZHA_SERVER: document.getElementById('m-nezha-server').value, NEZHA_KEY: document.getElementById('m-nezha-key').value, CFIP: document.getElementById('m-cfip').value, CFPORT: document.getElementById('m-cfport').value, NAME: document.getElementById('m-name').value }; await fetch('/api/apps/music/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ params }) }); loadMusicStatus(); }
            async function stopMusic() { await fetch('/api/apps/music/stop', { method: 'POST' }); loadMusicStatus(); }
            async function uninstallMusic() { if(!confirm('确认卸载？')) return; await fetch('/api/apps/music/uninstall', { method: 'DELETE' }); loadMusicStatus(); }

            async function updateSystemStatus() { try { const r = await fetch('/api/system/status'); const d = await r.json(); document.getElementById('mem-percent').innerText = d.percent + '%'; document.getElementById('mem-progress').style.width = d.percent + '%'; const prog = document.getElementById('mem-progress'); if(parseFloat(d.percent) > 80) prog.className = "h-full bg-gradient-to-r from-red-500 to-orange-400 transition-all duration-700 rounded-full"; else prog.className = "h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700 rounded-full"; } catch(e){} }
            async function uploadFile(botId, input) { if (!input.files[0]) return; const formData = new FormData(); formData.append('file', input.files[0]); const res = await fetch(\`/api/bots/\${botId}/upload\`, { method: 'POST', body: formData }); alert(res.ok ? '✅ 同步成功' : '❌ 同步失败'); input.value = ''; }
            async function addBot() { await fetch('/api/bots', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ host: document.getElementById('h').value, username: document.getElementById('u').value })}); updateUI(true); }
            async function restartNow(id) { await fetch('/api/bots/'+id+'/restart-now', { method: 'POST' }); updateUI(true); }
            async function setTimer(id, value, unit) { await fetch('/api/bots/'+id+'/set-timer', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ value, unit })}); updateUI(true); }
            async function savePto(id) { const data = { url: document.getElementById('url-'+id).value, id: document.getElementById('sid-'+id).value, key: document.getElementById('key-'+id).value, defaultDir: document.getElementById('ddir-'+id).value }; await fetch('/api/bots/'+id+'/pto-config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)}); updateUI(true); }
            async function toggleGuard(id) { await fetch('/api/bots/'+id+'/toggle-guard', { method: 'POST' }); updateUI(true); }
            async function toggle(id, type) { await fetch('/api/bots/'+id+'/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type })}); updateUI(true); }
            async function removeBot(id) { if(confirm('确认移除？')) { await fetch('/api/bots/'+id, { method: 'DELETE' }); updateUI(true); } }
            
            async function updateUI(force = false) {
                if (!force && document.activeElement && document.activeElement.tagName === 'INPUT') return;
                const openDetails = Array.from(document.querySelectorAll('details[open]')).map(el => el.id);
                const r = await fetch('/api/bots'); const d = await r.json();
                document.getElementById('list').innerHTML = d.bots.map(b => \`<div class="glass rounded-3xl overflow-hidden border-t-4 \${b.status==='在线'?'border-emerald-500':'border-red-500'} card-hover flex flex-col"><div class="p-6 flex-1 flex flex-col gap-4"><div class="flex justify-between items-center"><div><div class="flex items-center gap-2.5"><h3 class="text-xl font-extrabold tracking-tight">\${b.username}</h3><span class="px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1.5 \${b.status==='在线'?'bg-emerald-500/20 text-emerald-400':'bg-red-500/20 text-red-400'}"><span class="status-dot \${b.status==='在线'?'online':'offline'}"></span>\${b.status}</span></div><p class="text-xs text-slate-500 mt-1 font-medium">\${b.host}:\${b.port}</p></div><button onclick="removeBot('\${b.id}')" class="w-8 h-8 rounded-full bg-slate-800 hover:bg-red-600 hover:text-white text-slate-500 transition-colors flex items-center justify-center text-sm font-bold shadow-inner">✕</button></div><div class="log-box bg-black/60 rounded-2xl p-4 h-40 overflow-y-auto font-mono text-[11px] border border-slate-800/50 shadow-inner">\${b.logs.map(l => \`<div class="mb-1.5 \${l.color} flex"><span class="opacity-30 mr-2 shrink-0 select-none">[\${l.time}]</span><span>\${l.msg}</span></div>\`).join('')}</div><div class="grid grid-cols-3 gap-2"><button onclick="toggle('\${b.id}','ai')" class="toggle-btn \${b.settings.ai?'bg-blue-600/90 shadow-lg shadow-blue-500/30 text-white':'off'} py-2.5 rounded-xl text-xs font-bold">👁️ AI视角</button><button onclick="toggle('\${b.id}','walk')" class="toggle-btn \${b.settings.walk?'bg-emerald-600/90 shadow-lg shadow-emerald-500/30 text-white':'off'} py-2.5 rounded-xl text-xs font-bold">👣 巡逻</button><button onclick="toggle('\${b.id}','chat')" class="toggle-btn \${b.settings.chat?'bg-orange-600/90 shadow-lg shadow-orange-500/30 text-white':'off'} py-2.5 rounded-xl text-xs font-bold">💬 喊话</button></div><div class="bg-slate-900/60 p-4 rounded-2xl border border-slate-800/50"><div class="flex justify-between items-center mb-3"><h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider">重启序列</h4><span class="text-[10px] text-slate-500">下次: <span class="text-cyan-400 font-semibold">\${b.nextRestart}</span></span></div><div class="grid grid-cols-2 gap-2 mb-3"><div><input id="min-\${b.id}" type="number" placeholder="分钟" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><button onclick="setTimer('\${b.id}', document.getElementById('min-\${b.id}').value, 'min')" class="mt-1.5 w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-xl text-[10px] font-bold transition-colors">设定分钟</button></div><div><input id="hour-\${b.id}" type="number" placeholder="小时" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><button onclick="setTimer('\${b.id}', document.getElementById('hour-\${b.id}').value, 'hour')" class="mt-1.5 w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-xl text-[10px] font-bold transition-colors">设定小时</button></div></div><button onclick="restartNow('\${b.id}')" class="btn-danger w-full py-2.5 rounded-xl text-xs font-bold uppercase active:scale-95 transition-all">⚡ 立即重启</button></div><details id="pto-\${b.id}" class="group"><summary class="flex justify-between items-center cursor-pointer list-none bg-slate-900/60 p-3 rounded-2xl border border-slate-800/50 hover:border-slate-700 transition-colors"><span class="text-xs font-bold text-slate-400 uppercase tracking-wider">🦖 翼龙同步</span><span class="transition group-open:rotate-180 text-slate-500 text-xs">▼</span></summary><div class="mt-2 space-y-2 p-3 bg-slate-900/60 rounded-2xl border border-slate-800/50"><input oninput="saveDraft('\${b.id}', 'url', this.value)" id="url-\${b.id}" placeholder="面板地址" value="\${getDraft(b.id, 'url', b.settings.pterodactyl?.url)}" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><div class="grid grid-cols-2 gap-2"><input oninput="saveDraft('\${b.id}', 'sid', this.value)" id="sid-\${b.id}" placeholder="服务器 ID" value="\${getDraft(b.id, 'sid', b.settings.pterodactyl?.id)}" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input oninput="saveDraft('\${b.id}', 'ddir', this.value)" id="ddir-\${b.id}" placeholder="目录 (默认/)" value="\${getDraft(b.id, 'ddir', b.settings.pterodactyl?.defaultDir)}" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-emerald-400"></div><input oninput="saveDraft('\${b.id}', 'key', this.value)" id="key-\${b.id}" type="password" placeholder="API Key" value="\${getDraft(b.id, 'key', b.settings.pterodactyl?.key)}" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><div class="grid grid-cols-2 gap-2 pt-1"><button onclick="savePto('\${b.id}')" class="bg-slate-800 hover:bg-slate-700 text-[10px] py-2.5 rounded-xl font-bold transition-colors">💾 保存凭据</button><button onclick="document.getElementById('f-\${b.id}').click()" class="btn-primary text-[10px] py-2.5 rounded-xl font-bold">🚀 同步文件</button><input type="file" id="f-\${b.id}" class="hidden" onchange="uploadFile('\${b.id}', this)"></div><button onclick="toggleGuard('\${b.id}')" class="toggle-btn \${b.settings.pterodactyl?.guard?'bg-indigo-600/90 shadow-lg shadow-indigo-500/30 text-white':'off'} w-full py-2.5 rounded-xl text-[10px] font-bold mt-2">🛡️ 守护 \${b.settings.pterodactyl?.guard?'开启':'关闭'}</button></div></details></div></div>\`).join('');
                openDetails.forEach(id => { const el = document.getElementById(id); if (el) el.open = true; });
            }

            const welcomeAudio = document.getElementById('welcome-audio'); welcomeAudio.volume = 0.8; let playPromise = welcomeAudio.play(); if (playPromise !== undefined) { playPromise.catch(() => { const playOnInteraction = () => { welcomeAudio.play(); document.removeEventListener('click', playOnInteraction); document.removeEventListener('keydown', playOnInteraction); }; document.addEventListener('click', playOnInteraction); document.addEventListener('keydown', playOnInteraction); }); }
            setInterval(() => { updateUI(false); updateSystemStatus(); const modal = document.getElementById('modal-app-center'); if(modal.classList.contains('active')) { if(document.getElementById('view-ff').classList.contains('active-view')) loadFFStatus(); if(document.getElementById('view-music').classList.contains('active-view')) loadMusicStatus(); } }, 3000);
            updateUI(true);
        </script>
    </body></html>`);
});

const PORT = process.env.SERVER_PORT || 4681;
app.listen(PORT, '0.0.0.0', () => { if (fsSync.existsSync(CONFIG_FILE)) { try { const saved = JSON.parse(fsSync.readFileSync(CONFIG_FILE)); saved.forEach(b => createSmartBot('bot_'+Math.random().toString(36).substr(2,5), b.host, b.port, b.username, b.logs || [], b.settings)); } catch (e) {} } });