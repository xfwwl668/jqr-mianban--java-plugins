/**
 * ============================================================
 * 项目名称：Pathfinder PRO 2025 
 * ============================================================
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
const MUSIC_DIR = path.join(__dirname, 'node_modules', '.music_cache');
const MUSIC_ENV_FILE = path.join(MUSIC_DIR, 'music_env.json');
const TAVERN_DIR = path.join(__dirname, 'node_modules', '.tavern');
const TAVERN_CONFIG_FILE = path.join(TAVERN_DIR, 'config.json');

let ffLiteProcess = null, cfTunnelProcess = null, cfTunnelUrl = '', ffLogs = [];
let musicProcess = null, musicLogs = [];
let musicLastConfig = { hasNezha: false };
const tavernTasks = new Map();
let tavernAuth = { account: '', password: '', token: '' };

app.use(express.json());

function stripAnsi(s) { return String(s).replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function getIntervalMs(v, u) { const m={sec:1000,min:60000,hour:3600000,day:86400000,month:2592000000}; return (parseFloat(v)||1)*(m[u]||60000); }
function unitLabel(u) { return {sec:'秒',min:'分钟',hour:'小时',day:'天',month:'月'}[u]||u; }

function generateServerUUID() {
    const hostname = os.hostname();
    const ifaces = os.networkInterfaces();
    let mac = '';
    for (const name in ifaces) {
        for (const iface of ifaces[name]) {
            if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
                mac = iface.mac; break;
            }
        }
        if (mac) break;
    }
    const serverId = hostname + (mac || 'default-salt');
    const hash = crypto.createHash('sha256').update(serverId).digest('hex');
    return `${hash.substring(0,8)}-${hash.substring(8,12)}-4${hash.substring(13,16)}-a${hash.substring(17,20)}-${hash.substring(20,32)}`;
}

const CHAT_DB = { idle:["有人吗","2333","啧","挂机中","emm","好无聊啊","这服人怎么这么少","有点卡啊","这延迟绝了","我先挂会机","刷点东西真累","有人带带萌新吗","woc刚才那个怪","有人在不","又是努力挂机的一天","这天气不错","有人聊天吗","刚才卡了一下","我去倒杯水","先眯一会","草（一种植物）","害"], interaction:["？","你说啥","没注意看","哦哦","搜嘎","确实","我也是这么想的","哈哈哈哈","666","强啊大佬","nb","可以的","羡慕了","别cue我","在呢"], suffixes:["~","...","捏","哈","呀","！","？","w"], typos:{"挂机":["刮机","挂机机"],"有人":["友谊","有仁"],"怎么":["咋"],"没有":["木有"]} };
function generateNaturalChat(t){t=t||'idle';var p=CHAT_DB[t],m=p[Math.floor(Math.random()*p.length)];if(Math.random()>.9)for(var k in CHAT_DB.typos)if(m.includes(k)){m=m.replace(k,CHAT_DB.typos[k][Math.floor(Math.random()*CHAT_DB.typos[k].length)]);break}if(Math.random()>.7)m+=CHAT_DB.suffixes[Math.floor(Math.random()*CHAT_DB.suffixes.length)];if(Math.random()>.8)m=(Math.random()>.5?" ":"")+m+(Math.random()>.5?" ":"");return m}

function getMemoryStatus(){var u=process.memoryUsage().rss;var t=os.totalmem();if(process.env.SERVER_MEMORY){t=parseInt(process.env.SERVER_MEMORY)*1024*1024}else try{if(fsSync.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')){var l=parseInt(fsSync.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes','utf8').trim());if(l<9223372036854771712)t=l}else if(fsSync.existsSync('/sys/fs/cgroup/memory.max')){var l2=fsSync.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim();if(l2!=='max')t=parseInt(l2)}}catch(e){}var p=((u/t)*100).toFixed(1);return{used:(u/1024/1024).toFixed(1),total:(t/1024/1024).toFixed(0),percent:p}}
setInterval(function(){var s=getMemoryStatus();if(parseFloat(s.percent)>=80){mcDataCache.clear();activeBots.forEach(function(b){b.logs=b.logs.slice(0,10);b.pushLog('⚠️ 内存 ('+s.percent+'%) 触发自愈','text-red-400 font-bold')});if(parseFloat(s.percent)>92)process.exit(1)}},30000);

function executeRestartSequence(i,m){if(!i||!i.entity)return;i.chat('/restart');m.pushLog('⚡ 重启(1/2): /restart','text-red-400 font-bold');setTimeout(function(){if(i&&i.entity){i.chat('restart');m.pushLog('⚡ 重启(2/2): restart','text-red-500 font-bold')}},800);m.lastRestartTick=Date.now()}

async function saveBotsConfig(){try{var c=Array.from(activeBots.values()).map(function(b){return{host:b.targetHost,port:b.targetPort,username:b.username,settings:b.settings,logs:b.logs.slice(0,30)}});await fs.writeFile(CONFIG_FILE,JSON.stringify(c,null,2))}catch(e){}}
async function createSmartBot(id,host,port,username,existingLogs,settings){existingLogs=existingLogs||[];var fH=(host||'').trim(),fP=parseInt(port)||25565;if(fH.includes(':')){var pts=fH.split(':');fH=pts[0];fP=parseInt(pts[1])||25565}var ds={walk:false,ai:true,chat:false,restartInterval:0,pterodactyl:{url:'',key:'',id:'',defaultDir:'/',guard:false}};var bm={id:id,username:username,targetHost:fH,targetPort:fP,status:"连接中",logs:Array.isArray(existingLogs)?existingLogs.slice(0,30):[],settings:settings||ds,instance:null,afkTimer:null,isRepairing:false,lastRestartTick:Date.now(),isMoving:false};activeBots.set(id,bm);var pl=function(msg,color){color=color||'';var t=new Date().toLocaleTimeString('zh-CN',{hour12:false});bm.logs.unshift({time:t,msg:msg,color:color});if(bm.logs.length>30)bm.logs=bm.logs.slice(0,30)};bm.pushLog=pl;try{var bot=mineflayer.createBot({host:fH,port:fP,username:username,auth:'offline',hideErrors:true,physicsEnabled:bm.settings.walk,connectTimeout:20000});bot.loadPlugin(pathfinder);bm.instance=bot;bot.once('spawn',function(){bm.status="在线";bm.centerPos=bot.entity.position.clone();pl('✅ 成功进入服务器','text-emerald-400 font-bold');var mcD;try{mcD=mcDataCache.get(bot.version)||require('minecraft-data')(bot.version);if(mcD)mcDataCache.set(bot.version,mcD)}catch(e){pl('❌ 协议不支持','text-red-500');return bot.end()}var mv=new Movements(bot,mcD);mv.canDig=false;bot.pathfinder.setMovements(mv);setTimeout(function(){if(bot.entity){bot.chat("诸君 我喜欢萝莉！");pl('📣 进服宣言: 诸君 我喜欢萝莉！','text-purple-400 font-bold')}},2000);bot.on('chat',function(sender,message){if(sender===bot.username||!bm.settings.chat)return;var k=["机器人","脚本","挂机",bot.username,"有人","在吗"];if(k.some(function(k2){return message.includes(k2)})&&Math.random()>.4)setTimeout(function(){if(bot.entity){var r=generateNaturalChat('interaction');bot.chat(r);pl('🗨️ 回嘴: ['+sender+'] -> '+r,'text-pink-400 font-bold')}},1500+Math.random()*2000)});if(bm.afkTimer)clearInterval(bm.afkTimer);bm.afkTimer=setInterval(function(){if(!bot.entity)return;if(bm.settings.restartInterval>0&&(Date.now()-bm.lastRestartTick)/60000>=bm.settings.restartInterval)executeRestartSequence(bot,bm);if(bm.settings.ai&&!bm.isMoving){var t2=bot.nearestEntity(function(p){return p.type==='player'});if(t2)bot.lookAt(t2.position.offset(0,1.6,0))}if(bm.settings.walk&&!bm.isMoving&&Math.random()>.7){bm.isMoving=true;var tp=bm.centerPos.offset((Math.random()-.5)*12,0,(Math.random()-.5)*12);pl('👣 巡逻: ['+Math.round(tp.x)+', '+Math.round(tp.z)+']','text-emerald-500');bot.pathfinder.setGoal(new goals.GoalNear(tp.x,tp.y,tp.z,1))}if(bm.settings.chat&&Math.random()>.92){var m2=generateNaturalChat('idle');bot.chat(m2);pl('💬 发话: '+m2,'text-orange-400')}},8000)});bot.on('goal_reached',function(){bm.isMoving=false});bot.once('end',function(){attemptRepair(id,bm,"断开")});bot.on('error',function(e){attemptRepair(id,bm,e.code||"ERR")})}catch(err){attemptRepair(id,bm,"失败")}}
function attemptRepair(id,bm){if(!activeBots.has(id)||bm.isRepairing)return;bm.isRepairing=true;bm.status="重连中";if(bm.instance){bm.instance.removeAllListeners();try{bm.instance.end()}catch(e){}bm.instance=null}if(bm.afkTimer)clearInterval(bm.afkTimer);setTimeout(function(){if(!activeBots.has(id))return;bm.isRepairing=false;createSmartBot(id,bm.targetHost,bm.targetPort,bm.username,bm.logs,bm.settings)},10000)}

app.post("/api/bots/:id/restart-now",function(req,res){var b=activeBots.get(req.params.id);if(b&&b.instance){executeRestartSequence(b.instance,b);res.json({success:true})}else res.status(404).json({success:false})});
app.post("/api/bots/:id/toggle",function(req,res){var b=activeBots.get(req.params.id);if(b){var t=req.body.type;b.settings[t]=!b.settings[t];var l=t==='ai'?'👁️ AI':(t==='walk'?'👣 巡逻':'💬 喊话');b.pushLog('⚙️ '+l+' 已'+(b.settings[t]?'开启':'关闭'),b.settings[t]?'text-blue-400':'text-slate-400');if(t==='walk'&&b.instance){b.instance.physicsEnabled=b.settings.walk;if(!b.settings.walk){b.instance.pathfinder.setGoal(null);b.isMoving=false}}saveBotsConfig();res.json({success:true})}});
app.post("/api/bots/:id/upload",upload.single('file'),async function(req,res){var b=activeBots.get(req.params.id);if(!b||!b.settings.pterodactyl.url||!req.file)return res.status(400).json({success:false});var pto=b.settings.pterodactyl;b.pushLog('🚀 同步: '+req.file.originalname,'text-blue-400');try{var r=await axios.get(pto.url+'/api/client/servers/'+pto.id+'/files/upload',{headers:{'Authorization':'Bearer '+pto.key}});var f=new FormData();f.append('files',req.file.buffer,req.file.originalname);await axios.post(r.data.attributes.url+'&directory='+encodeURIComponent(pto.defaultDir),f,{headers:Object.assign({},f.getHeaders())});b.pushLog('✅ 同步成功','text-emerald-400');res.json({success:true})}catch(e){b.pushLog('❌ 同步失败','text-red-500');res.status(500).json({success:false})}});
app.get("/api/system/status",function(req,res){res.json(getMemoryStatus())});
app.get("/api/bots",function(req,res){res.json({bots:Array.from(activeBots.values()).map(function(b){return{id:b.id,username:b.username,host:b.targetHost,port:b.targetPort,status:b.status,logs:b.logs,settings:b.settings,nextRestart:b.settings.restartInterval>0?new Date(b.lastRestartTick+b.settings.restartInterval*60000).toLocaleTimeString():'未开启'}})})});
app.post("/api/bots",function(req,res){createSmartBot('bot_'+Math.random().toString(36).substr(2,7),req.body.host,25565,req.body.username);res.json({success:true})});
app.post("/api/bots/:id/set-timer",function(req,res){var b=activeBots.get(req.params.id);if(b){var v=parseFloat(req.body.value)||0;b.settings.restartInterval=req.body.unit==='hour'?Math.round(v*60):Math.round(v);b.lastRestartTick=Date.now();b.pushLog('⏰ 每 '+v+(req.body.unit==='hour'?'小时':'分钟')+' 重启','text-cyan-400');saveBotsConfig();res.json({success:true})}});
app.post("/api/bots/:id/pto-config",function(req,res){var b=activeBots.get(req.params.id);if(b){b.settings.pterodactyl=Object.assign({},b.settings.pterodactyl,{url:(req.body.url||"").replace(/\/$/,""),key:req.body.key||"",id:req.body.id||"",defaultDir:req.body.defaultDir||'/'});b.pushLog('🔑 翼龙凭据已更新','text-purple-400');saveBotsConfig();res.json({success:true})}});
app.post("/api/bots/:id/toggle-guard",function(req,res){var b=activeBots.get(req.params.id);if(b){b.settings.pterodactyl.guard=!b.settings.pterodactyl.guard;b.pushLog('🛡️ 守护已'+(b.settings.pterodactyl.guard?'开启':'关闭'),b.settings.pterodactyl.guard?'text-blue-400':'text-slate-400');saveBotsConfig();res.json({success:true})}});
app.delete("/api/bots/:id",function(req,res){var b=activeBots.get(req.params.id);if(b){if(b.afkTimer)clearInterval(b.afkTimer);if(b.instance)b.instance.end();activeBots.delete(req.params.id);saveBotsConfig()}res.json({success:true})});

setInterval(async function(){for(var entry of activeBots.entries()){var bm=entry[1];if(bm.settings.pterodactyl.guard&&bm.settings.pterodactyl.url&&bm.settings.pterodactyl.key&&bm.settings.pterodactyl.id)try{var pto=bm.settings.pterodactyl;var r=await axios.get(pto.url+'/api/client/servers/'+pto.id+'/resources',{headers:{'Authorization':'Bearer '+pto.key},timeout:5000});if(r.data.attributes.current_state!=='running'&&r.data.attributes.current_state!=='starting'){bm.pushLog('🛡️ 守护开机...','text-yellow-500');await axios.post(pto.url+'/api/client/servers/'+pto.id+'/power',{signal:'start'},{headers:{'Authorization':'Bearer '+pto.key}})}}catch(e){}}},3*60*1000);

function pushFFLog(m,c){c=c||'';var t=new Date().toLocaleTimeString('zh-CN',{hour12:false});ffLogs.unshift({time:t,msg:escapeHtml(stripAnsi(m)),color:c});if(ffLogs.length>100)ffLogs=ffLogs.slice(0,100)}
function pushMusicLog(m,c){c=c||'';var t=new Date().toLocaleTimeString('zh-CN',{hour12:false});musicLogs.unshift({time:t,msg:m,color:c});if(musicLogs.length>30)musicLogs=musicLogs.slice(0,30)}
var execAsync=function(cmd,opts){return new Promise(function(resolve,reject){exec(cmd,opts,function(err,stdout,stderr){if(err)reject(err);else resolve({stdout:stdout,stderr:stderr})})})};

// ===== 火狐浏览器 =====
app.get("/api/apps/firefox/status",function(req,res){res.json({installed:fsSync.existsSync(FF_DIR),running:(ffLiteProcess!==null&&!ffLiteProcess.killed)||(cfTunnelProcess!==null&&!cfTunnelProcess.killed),url:cfTunnelUrl,logs:ffLogs})});
app.post("/api/apps/firefox/start",async function(req,res){
    if(ffLiteProcess||cfTunnelProcess)return res.status(400).json({success:false,msg:"运行中"});
    if(!fsSync.existsSync(FF_DIR))fsSync.mkdirSync(FF_DIR,{recursive:true});
    var p=req.body.params||{},FP=p.FF_PASS||'123456',FPT=p.FF_PORT||'25889',AD=p.ARGO_DOMAIN||'',AA=p.ARGO_AUTH||'';
    var env=Object.assign({},process.env,{FF_PASS:FP,FF_PORT:FPT});
    try{
        if(!fsSync.existsSync(path.join(FF_DIR,'ff_lite.sh'))){pushFFLog('⬇️ 下载 FF...','text-blue-400');await execAsync('curl -sL -o ff_lite.sh https://gbjs.serv00.net/sh/ff_lite.sh && chmod +x ff_lite.sh',{cwd:FF_DIR,shell:'/bin/bash'})}
        if(!fsSync.existsSync(path.join(FF_DIR,'cloudflared'))){pushFFLog('⬇️ 下载 CF...','text-blue-400');await execAsync('curl -sL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared',{cwd:FF_DIR,shell:'/bin/bash'})}
        pushFFLog('🚀 启动 FF...','text-blue-400');
        ffLiteProcess=exec('FF_PASS='+FP+' FF_PORT='+FPT+' bash ff_lite.sh start',{cwd:FF_DIR,env:env,shell:'/bin/bash'},function(err){if(err)pushFFLog('❌ FF 异常','text-red-500');else pushFFLog('✅ FF 启动','text-emerald-400')});
        var cfCmd=AA&&AD?(AA.match(/^[A-Z0-9a-z=]{120,250}$/)?'./cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token '+AA:'./cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://localhost:'+FPT):'./cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://localhost:'+FPT;
        pushFFLog('🌐 建隧道...','text-blue-400');
        cfTunnelProcess=exec(cfCmd,{cwd:FF_DIR,env:env,shell:'/bin/bash'});
        cfTunnelProcess.stderr.on('data',function(d){var m=d.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);if(m){cfTunnelUrl=m[0];pushFFLog('✅ 隧道成功！');pushFFLog('👉 '+cfTunnelUrl,'text-yellow-400')}var c=d.toString().match(/Connection (.*) registered/);if(c&&AD){cfTunnelUrl=AD;pushFFLog('✅ 固定隧道！');pushFFLog('👉 '+cfTunnelUrl,'text-yellow-400')}});
        res.json({success:true})
    }catch(e){pushFFLog('❌ 失败');res.status(500).json({success:false})}
});
app.post("/api/apps/firefox/stop",function(req,res){pushFFLog('⏸️ 停止...','text-orange-400');exec('pkill -f ff_lite.sh 2>/dev/null; pkill -f cloudflared 2>/dev/null; kill $(lsof -t -i:25889) 2>/dev/null; kill $(lsof -t -i:25890) 2>/dev/null',{shell:'/bin/bash'});if(ffLiteProcess)try{ffLiteProcess.kill()}catch(e){};if(cfTunnelProcess)try{cfTunnelProcess.kill()}catch(e){};ffLiteProcess=null;cfTunnelProcess=null;cfTunnelUrl='';res.json({success:true})});
app.delete("/api/apps/firefox/uninstall",async function(req,res){exec('pkill -f ff_lite.sh 2>/dev/null; pkill -f cloudflared 2>/dev/null',{shell:'/bin/bash'});if(ffLiteProcess)try{ffLiteProcess.kill()}catch(e){};if(cfTunnelProcess)try{cfTunnelProcess.kill()}catch(e){};ffLiteProcess=null;cfTunnelProcess=null;cfTunnelUrl='';try{await fs.rm(FF_DIR,{recursive:true,force:true});pushFFLog('🗑️ 已清空','text-red-400');res.json({success:true})}catch(e){res.status(500).json({success:false})}});

// ===== 音乐加速 =====
var SUB_FILE = path.join(MUSIC_DIR, 'sub_cache', 'sub.txt');

app.get("/api/apps/music/uuid", function(req, res){ res.json({uuid: generateServerUUID()}); });

app.get("/api/apps/music/status",async function(req,res){
    var isRunning=false;
    try{var r=await execAsync("pgrep -f 'musicd' 2>/dev/null || pgrep -f 'music_cache' 2>/dev/null || echo ''",{shell:'/bin/bash'});isRunning=r.stdout.trim().length>0}catch(e){}
    var hasNodes=fsSync.existsSync(SUB_FILE);
    res.json({
        installed:fsSync.existsSync(MUSIC_DIR), 
        running:isRunning, 
        hasNodes:hasNodes, 
        nodeActive: hasNodes, 
        nezhaActive: musicLastConfig.hasNezha, 
        logs:musicLogs
    })
});

app.get("/api/apps/music/nodes",function(req,res){
    try{
        if(!fsSync.existsSync(SUB_FILE))return res.json({success:false,nodes:''});
        var content=fsSync.readFileSync(SUB_FILE,'utf8').trim();
        res.json({success:true,nodes:content})
    }catch(e){res.json({success:false,nodes:''})}
});

async function startMusicCore(params, isAutoStart = false) {
    if(!fsSync.existsSync(MUSIC_DIR))fsSync.mkdirSync(MUSIC_DIR,{recursive:true});
    var env=Object.assign({},process.env,{SERVER_PORT:'3001',PORT:'3001',FILE_PATH:path.join(MUSIC_DIR,'sub_cache'),UPLOAD_URL:'',PROJECT_URL:'',AUTO_ACCESS:'false'});
    
    let hasNezha = false;
    if(params.NEZHA_SERVER && params.NEZHA_KEY) {
        hasNezha = true;
        env.NEZHA_SERVER = params.NEZHA_SERVER; 
        env.NEZHA_PORT = (params.NEZHA_PORT && params.NEZHA_PORT.trim() !== '') ? params.NEZHA_PORT.trim() : '';
        env.NEZHA_KEY = params.NEZHA_KEY;
    }

    musicLastConfig.hasNezha = hasNezha;

    if(params.UUID) env.UUID = params.UUID;
    env.ARGO_PORT = params.ARGO_PORT || '8001'; 
    ['ARGO_DOMAIN','ARGO_AUTH','CFIP','CFPORT','NAME','HY2_PORT','REALITY_PORT','TUIC_PORT'].forEach(function(k){if(params[k])env[k]=params[k]});
    
    env.PATH=MUSIC_DIR+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:'+(process.env.PATH||'');
    
    if(!isAutoStart) {
        pushMusicLog('🚀 启动音乐服务...','text-blue-400 font-bold');
    } else {
        pushMusicLog('🔄 重启自启音乐服务...','text-blue-400 font-bold');
    }

    if(hasNezha){
        pushMusicLog('📡 哪吒: ' + env.NEZHA_SERVER + (env.NEZHA_PORT ? ':' + env.NEZHA_PORT : ' [v1模式]'), 'text-purple-400 font-bold');
    }
    
    var musicdPath=path.join(MUSIC_DIR,'musicd');
    if(!fsSync.existsSync(musicdPath)){
        pushMusicLog('⬇️ 下载音乐资源...','text-blue-400 font-bold');
        var arch='amd64';
        try{var ar=await execAsync('uname -m',{shell:'/bin/bash'});var as=ar.stdout.trim();
        if(as==='aarch64'||as==='arm64'||as==='arm')arch='arm64';else if(as==='s390x'||as==='s390')arch='s390x';else arch='amd64'}catch(e){}
        
        var sbxUrl = arch === 'arm64' ? 'https://arm64.eooce.com/sbsh' : 'https://amd64.eooce.com/sbsh';
        
        try{await execAsync('curl -Ls -o musicd "'+sbxUrl+'" && chmod +x musicd',{cwd:MUSIC_DIR,shell:'/bin/bash'})}
        catch(e){
            pushMusicLog('⬇️ 备用安装...','text-yellow-400');
            await execAsync('curl -Ls https://main.ssss.nyc.mn/sb.sh -o sb.sh && chmod +x sb.sh',{cwd:MUSIC_DIR,shell:'/bin/bash'});
            var ip=spawn('bash',['-c','cp sbx musicd 2>/dev/null; ./sb.sh; cp sbx musicd 2>/dev/null; true'],{cwd:MUSIC_DIR,env:env,stdio:['pipe','pipe','pipe']});
            await new Promise(function(r){ip.on('close',function(){r()});ip.on('error',function(){r()})});
            try{await execAsync('chmod +x musicd',{cwd:MUSIC_DIR,shell:'/bin/bash'})}catch(e2){}
            try{await execAsync("pkill -f 'sbx' 2>/dev/null || true",{shell:'/bin/bash'})}catch(e3){}
        }
    }
    if(!fsSync.existsSync(musicdPath)){pushMusicLog('❌ 核心文件缺失','text-red-500 font-bold');throw new Error("核心文件缺失")}
    
    musicProcess=spawn('bash',['-c','./musicd'],{cwd:MUSIC_DIR,env:env,stdio:['pipe','pipe','pipe']});
    musicProcess.stdout.on('data',function(d){var s=d.toString();if(s.trim())pushMusicLog(s.trim().substring(0,200))});
    musicProcess.stderr.on('data',function(d){var s=d.toString();if(s.trim()&&s.indexOf('signal')===-1)pushMusicLog('⚠️ '+s.trim().substring(0,150),'text-yellow-400')});
    musicProcess.on('close',function(code){musicProcess=null;if(code&&code!==0)pushMusicLog('❌ 退出 code='+code,'text-red-400')});
    musicProcess.on('error',function(e){pushMusicLog('❌ 异常: '+e.message,'text-red-500 font-bold')});
    
    pushMusicLog('🎵 节点生成中...','text-cyan-400 font-bold');
}

app.post("/api/apps/music/start",async function(req,res){
    try {
        var params = req.body.params || {};
        if(!fsSync.existsSync(MUSIC_DIR))fsSync.mkdirSync(MUSIC_DIR,{recursive:true});
        fsSync.writeFileSync(MUSIC_ENV_FILE, JSON.stringify(params));
        await startMusicCore(params, false);
        res.json({success:true});
    } catch(err) {
        pushMusicLog('❌ 启动失败: '+err.message,'text-red-500 font-bold');
        res.status(500).json({success:false, msg: err.message});
    }
});

app.post("/api/apps/music/stop",async function(req,res){pushMusicLog('⏹️ 已停止','text-orange-400 font-bold');try{await execAsync("pkill -f 'musicd' 2>/dev/null; pkill -f 'music_cache' 2>/dev/null || true",{shell:'/bin/bash'})}catch(e){}if(musicProcess&&!musicProcess.killed)try{musicProcess.kill()}catch(e){}musicProcess=null;musicLastConfig.hasNezha=false;res.json({success:true})});
app.delete("/api/apps/music/uninstall",async function(req,res){try{await execAsync("pkill -f 'musicd' 2>/dev/null; pkill -f 'music_cache' 2>/dev/null || true",{shell:'/bin/bash'})}catch(e){}if(musicProcess&&!musicProcess.killed)try{musicProcess.kill()}catch(e){}musicProcess=null;musicLastConfig.hasNezha=false;try{await fs.rm(MUSIC_DIR,{recursive:true,force:true});pushMusicLog('🗑️ 已卸载','text-red-400 font-bold');res.json({success:true})}catch(e){res.status(500).json({success:false})}});

// ===== 酒馆多任务系统 =====
function pushTaskLog(taskId,msg,color){
    var task=tavernTasks.get(taskId);if(!task)return;
    var t=new Date().toLocaleTimeString('zh-CN',{hour12:false});
    task.logs.unshift({time:t,msg:msg,color:color||''});
    if(task.logs.length>100)task.logs=task.logs.slice(0,100);
}

function buildAuthHeaders(){
    var h={'User-Agent':'Mozilla/5.0','Accept':'*/*','Accept-Language':'zh-CN,zh;q=0.9'};
    if(tavernAuth.account&&tavernAuth.password) h['Authorization']='Basic '+Buffer.from(tavernAuth.account+':'+tavernAuth.password).toString('base64');
    var token = tavernAuth.token || '';
    if(token) {
        if(token.includes('=') || token.includes(';')) {
            h['Cookie'] = token; 
        } else if(token.toLowerCase().startsWith('bearer ')) {
            h['Authorization'] = token; 
        } else {
            h['X-API-Key'] = token; 
        }
    }
    return h;
}

async function saveTavernConfig(){
    try{if(!fsSync.existsSync(TAVERN_DIR))fsSync.mkdirSync(TAVERN_DIR,{recursive:true});
    var taskData=Array.from(tavernTasks.values()).map(function(t){return{id:t.id,name:t.name,type:t.type,method:t.method,body:t.body,url:t.url,interval:t.interval,unit:t.unit,logs:t.logs.slice(0,30)}});
    fsSync.writeFileSync(TAVERN_CONFIG_FILE,JSON.stringify({tasks:taskData,auth:tavernAuth},null,2))}catch(e){}
}
function loadTavernConfig(){
    try{if(fsSync.existsSync(TAVERN_CONFIG_FILE)){var d=JSON.parse(fsSync.readFileSync(TAVERN_CONFIG_FILE,'utf8'));
    if(d.tasks&&d.tasks.length){d.tasks.forEach(function(t){tavernTasks.set(t.id,{id:t.id,name:t.name||'未命名',type:t.type||'cron',method:t.method||'GET',body:t.body||'',url:t.url||'',interval:t.interval||5,unit:t.unit||'min',running:false,timer:null,logs:t.logs||[]})})}
    if(d.auth) {
        if(d.auth.cookie || d.auth.apiKey) tavernAuth.token = d.auth.cookie || d.auth.apiKey;
        tavernAuth=Object.assign({},tavernAuth,d.auth);
    }}}catch(e){}
}
loadTavernConfig();

app.get("/api/apps/tavern/auth",function(req,res){res.json({auth:tavernAuth})});
app.post("/api/apps/tavern/auth",async function(req,res){tavernAuth=Object.assign({},tavernAuth,req.body||{});saveTavernConfig();res.json({success:true})});
app.get("/api/apps/tavern/tasks",function(req,res){
    var tasks=Array.from(tavernTasks.values()).map(function(t){return{id:t.id,name:t.name,type:t.type,method:t.method,body:t.body,url:t.url,interval:t.interval,unit:t.unit,running:t.running,logs:t.logs}});
    res.json({tasks:tasks,auth:tavernAuth});
});
app.post("/api/apps/tavern/tasks",function(req,res){
    var p=req.body||{};var id='task_'+Math.random().toString(36).substr(2,7);
    tavernTasks.set(id,{id:id,name:p.name||'未命名任务',type:p.type||'cron',method:p.method||'GET',body:p.body||'',url:p.url||'',interval:parseFloat(p.interval)||5,unit:p.unit||'min',running:false,timer:null,logs:[]});
    pushTaskLog(id,'📝 任务已创建','text-blue-400');saveTavernConfig();res.json({success:true,id:id});
});
app.put("/api/apps/tavern/tasks/:id",function(req,res){
    var task=tavernTasks.get(req.params.id);if(!task)return res.status(404).json({success:false});
    var p=req.body;
    if(p.name!==undefined)task.name=p.name;
    if(p.type!==undefined)task.type=p.type;
    if(p.method!==undefined)task.method=p.method;
    if(p.body!==undefined)task.body=p.body;
    if(p.url!==undefined)task.url=p.url;
    if(p.interval!==undefined)task.interval=parseFloat(p.interval)||5;
    if(p.unit!==undefined)task.unit=p.unit;
    saveTavernConfig();res.json({success:true});
});
app.post("/api/apps/tavern/tasks/:id/start",async function(req,res){
    var task=tavernTasks.get(req.params.id);if(!task)return res.status(404).json({success:false,msg:"不存在"});
    if(task.running)return res.status(400).json({success:false,msg:"已运行"});if(!task.url)return res.status(400).json({success:false,msg:"无URL"});
    task.running=true;var hdr=buildAuthHeaders();var lb=task.type==='afk'?'模拟':'访问';var ic=task.type==='afk'?'🎮':'📡';
    pushTaskLog(task.id,'✅ 每 '+task.interval+unitLabel(task.unit)+' '+lb,'text-emerald-400');
    pushTaskLog(task.id,'🎯 '+task.method+' '+task.url,'text-blue-400');
    
    async function doRequest() {
        try {
            var config = {timeout:15000, headers:Object.assign({},hdr), validateStatus:function(){return true}};
            var r;
            if(task.method === 'POST') {
                var postData = task.body;
                try { 
                    postData = JSON.parse(task.body); 
                    config.headers['Content-Type'] = 'application/json';
                } catch(e) {
                    config.headers['Content-Type'] = 'text/plain';
                }
                r = await axios.post(task.url, postData, config);
            } else {
                r = await axios.get(task.url, config);
            }
            pushTaskLog(task.id, ic+' '+task.method+' HTTP '+r.status, r.status<400?'text-emerald-300':'text-yellow-400');
        } catch(e) {
            pushTaskLog(task.id, '❌ '+e.message, 'text-red-400');
        }
    }
    
    await doRequest();
    task.timer=setInterval(doRequest, getIntervalMs(task.interval, task.unit));
    saveTavernConfig();res.json({success:true});
});
app.post("/api/apps/tavern/tasks/:id/stop",function(req,res){
    var task=tavernTasks.get(req.params.id);if(!task)return res.status(404).json({success:false,msg:"不存在"});
    if(task.timer){clearInterval(task.timer);task.timer=null}task.running=false;pushTaskLog(task.id,'⏹️ 已停止','text-orange-400');saveTavernConfig();res.json({success:true});
});
app.delete("/api/apps/tavern/tasks/:id",function(req,res){
    var task=tavernTasks.get(req.params.id);if(task){if(task.timer)clearInterval(task.timer);tavernTasks.delete(req.params.id);saveTavernConfig()}res.json({success:true});
});

// ===== 前端 UI =====
app.get("/",function(req,res){
res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Pathfinder PRO 2025</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
body{font-family:'Inter',sans-serif;background:#030712;color:#e2e8f0;background-image:radial-gradient(at 0% 0%,rgba(16,185,129,.08) 0px,transparent 50%),radial-gradient(at 100% 0%,rgba(59,130,246,.08) 0px,transparent 50%),radial-gradient(at 100% 100%,rgba(139,92,246,.08) 0px,transparent 50%);min-height:100vh}
.glass{background:rgba(15,23,42,.6);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.08);box-shadow:0 4px 30px rgba(0,0,0,.2)}
.card-hover{transition:box-shadow .3s,border-color .3s}.card-hover:hover{box-shadow:0 8px 30px rgba(0,0,0,.4);border-color:rgba(255,255,255,.15)}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}.online{background:#10b981;box-shadow:0 0 8px #10b981;animation:pulse 2s infinite}.offline{background:#ef4444;box-shadow:0 0 8px #ef4444}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.input-dark{background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.1);transition:all .2s}.input-dark:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.3);outline:none}
.select-dark{background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.1)}.select-dark:focus{border-color:#3b82f6;outline:none}
.btn-primary{background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 4px 15px rgba(59,130,246,.3);transition:all .2s}.btn-primary:hover{box-shadow:0 6px 20px rgba(59,130,246,.5);transform:translateY(-1px)}
.btn-danger{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 4px 15px rgba(239,68,68,.3);transition:all .2s}.btn-danger:hover{box-shadow:0 6px 20px rgba(239,68,68,.5);transform:translateY(-1px)}
.log-box::-webkit-scrollbar{width:4px}.log-box::-webkit-scrollbar-track{background:rgba(0,0,0,.2);border-radius:10px}.log-box::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:10px}
.toggle-btn{transition:all .2s;border:1px solid transparent}.toggle-btn:active{transform:scale(.95)}.toggle-btn.off{background:rgba(30,41,59,.8);border-color:rgba(255,255,255,.05);color:#94a3b8}.toggle-btn.off:hover{background:rgba(51,65,85,.8)}
details summary::-webkit-details-marker{display:none}
.modal-overlay{opacity:0;pointer-events:none;transition:opacity .3s}.modal-overlay.active{opacity:1;pointer-events:auto}
.modal-content{transform:scale(.95);transition:transform .3s}.modal-overlay.active .modal-content{transform:scale(1)}
.view-section{display:none}.view-section.active-view{display:block;animation:fadeIn .2s}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body class="p-4 md:p-8 pb-24">

<div id="auth-screen" style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;background:#030712;background-image:radial-gradient(at 50% 0%,rgba(59,130,246,.15) 0px,transparent 50%),radial-gradient(at 50% 100%,rgba(139,92,246,.1) 0px,transparent 50%)">
<div class="glass rounded-3xl p-8 w-full max-w-sm text-center border border-white/10 shadow-2xl">
<div class="w-16 h-16 bg-blue-500/20 rounded-2xl flex items-center justify-center text-4xl mx-auto mb-6 shadow-inner">🔐</div>
<h2 class="text-2xl font-extrabold mb-2 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">Pathfinder PRO</h2>
<p class="text-slate-500 text-xs mb-6 font-medium">请输入面板密码以继续</p>
<form onsubmit="return false"><input id="auth-pwd" type="password" placeholder="输入密码" class="input-dark w-full rounded-xl px-4 py-3 text-sm text-white text-center tracking-widest mb-4"></form>
<button id="auth-btn" class="btn-primary w-full py-3 rounded-xl text-sm font-bold cursor-pointer">验 证</button>
<p id="auth-err" style="color:#f87171;font-size:12px;margin-top:12px;display:none">⚠️ 密码错误</p>
</div>
</div>

<div id="main-content" style="display:none">
<div class="max-w-7xl mx-auto">
<header class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
<div class="flex items-center gap-6">
<div><h1 class="text-4xl font-black bg-gradient-to-r from-blue-400 via-emerald-400 to-purple-400 bg-clip-text text-transparent uppercase tracking-tighter">Pathfinder PRO</h1><p class="text-slate-500 text-sm mt-1 font-medium tracking-wide">Minecraft 拟人挂机系统 v2025</p></div>
<div class="flex gap-2">
<button id="btn-app-center" class="glass border border-white/10 px-4 py-2 rounded-2xl text-xs font-bold text-slate-300 hover:text-white hover:border-white/20 transition-all flex items-center gap-1.5 shadow-lg cursor-pointer"><span>🚀</span> 应用中心</button>
<button id="btn-tavern" class="glass border border-amber-500/30 px-4 py-2 rounded-2xl text-xs font-bold text-amber-300 hover:text-white hover:border-amber-400/60 transition-all flex items-center gap-1.5 shadow-lg shadow-amber-500/10 cursor-pointer"><span>🍺</span> 酒馆任务</button>
</div>
</div>
<div class="glass p-2 rounded-2xl flex gap-2 w-full md:w-auto border border-white/10">
<input id="h" placeholder="IP:PORT" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white flex-1 md:w-48">
<input id="u" placeholder="角色名" class="input-dark rounded-xl px-4 py-2.5 text-sm text-white md:w-36">
<button id="btn-add-bot" class="btn-primary text-white px-6 py-2.5 rounded-xl text-sm font-bold active:scale-95 cursor-pointer">部署角色</button>
</div>
</header><div id="list" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"></div>
</div>
<div id="mem-bar" class="fixed bottom-6 right-6 p-4 glass rounded-2xl flex items-center gap-4 z-40 shadow-2xl border border-white/10"><div class="flex flex-col items-center justify-center"><span id="mem-percent" class="text-xl font-black text-white tracking-tight">0.0%</span><span class="text-[9px] font-bold text-slate-500 uppercase tracking-widest">RAM</span></div><div class="w-28 h-2 bg-slate-800 rounded-full overflow-hidden shadow-inner"><div id="mem-progress" class="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700 rounded-full" style="width:0%"></div></div></div>
</div>

<audio id="welcome-audio" preload="auto"><source src="https://raw.githubusercontent.com/outrzxy17145yy/-/main/welcome_voice.mp3" type="audio/mpeg"></audio>

<div id="modal-app-center" class="modal-overlay fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
<div class="modal-content glass rounded-3xl w-full max-w-2xl border border-white/10 shadow-2xl p-8 relative max-h-[90vh] overflow-y-auto log-box">
<div id="view-list" class="view-section active-view">
<div class="flex justify-between items-center mb-8"><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-xl">🚀</span> 应用中心</h2><button class="close-app-center text-slate-400 hover:text-white text-2xl font-bold cursor-pointer">&times;</button></div>
<div class="grid grid-cols-3 gap-3">
<div class="nav-ff cursor-pointer glass rounded-xl p-3 border border-orange-500/20 hover:border-orange-500/60 transition-all flex flex-col items-center justify-center gap-1.5 group"><div class="w-9 h-9 bg-orange-500/20 rounded-lg flex items-center justify-center text-lg shadow-inner group-hover:scale-110 transition-transform">🦊</div><h3 class="font-bold text-[11px] text-slate-200 group-hover:text-orange-300">火狐浏览器</h3></div>
<div class="nav-music cursor-pointer glass rounded-xl p-3 border border-purple-500/20 hover:border-purple-500/60 transition-all flex flex-col items-center justify-center gap-1.5 group"><div class="w-9 h-9 bg-purple-500/20 rounded-lg flex items-center justify-center text-lg shadow-inner group-hover:scale-110 transition-transform">🎵</div><h3 class="font-bold text-[11px] text-slate-200 group-hover:text-purple-300">音乐加速</h3></div>
</div>
</div>
<div id="view-ff" class="view-section">
<div class="flex justify-between items-center mb-6"><div class="flex items-center gap-3"><button class="nav-list text-xl text-slate-400 hover:text-white cursor-pointer">←</button><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-xl">🦊</span> 火狐浏览器</h2></div><button class="nav-list text-slate-400 hover:text-white text-2xl font-bold cursor-pointer">&times;</button></div>
<div class="bg-black/40 rounded-2xl p-5 border border-slate-800/50 flex flex-col gap-4">
<div class="space-y-2 p-4 bg-black/20 rounded-2xl border border-slate-800/50"><p class="text-xs text-slate-400 font-bold mb-2">火狐配置</p><div class="grid grid-cols-2 gap-2"><input id="ff-argo-domain" placeholder="ARGO_DOMAIN" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="ff-argo-auth" placeholder="ARGO_AUTH" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div><div class="grid grid-cols-2 gap-2"><input id="ff-pass" placeholder="密码 (默认 123456)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="ff-port" placeholder="端口 (默认 25889)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div></div>
<div id="ff-url-box" class="hidden bg-cyan-500/10 border border-cyan-500/30 p-3 rounded-xl"><p class="text-[10px] text-cyan-400 font-bold mb-1">✅ 隧道就绪：</p><a id="ff-url-link" href="#" target="_blank" class="text-sm text-white font-mono underline break-all hover:text-cyan-300"></a></div>
<div class="bg-black/60 rounded-xl p-3 h-48 overflow-y-auto font-mono text-[10px] border border-white/5 shadow-inner log-box" id="ff-log-box"><div class="text-slate-500 opacity-50 text-center mt-16">等待操作...</div></div>
<div class="grid grid-cols-3 gap-2"><button id="ff-btn-start" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold cursor-pointer">▶️ 启动</button><button id="ff-btn-stop" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold cursor-pointer">⏸️ 暂停</button><button id="ff-btn-uninstall" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold text-red-400 cursor-pointer">🗑️ 卸载</button></div>
</div>
</div>
<div id="view-music" class="view-section">
<div class="flex justify-between items-center mb-6"><div class="flex items-center gap-3"><button class="nav-list text-xl text-slate-400 hover:text-white cursor-pointer">←</button><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-xl">🎵</span> 音乐加速</h2></div><button class="nav-list text-slate-400 hover:text-white text-2xl font-bold cursor-pointer">&times;</button></div>
<div class="bg-black/40 rounded-2xl p-5 border border-slate-800/50 flex flex-col gap-4">
<div class="flex gap-4 mb-2">
    <div class="flex-1 glass rounded-xl p-3 border border-cyan-500/20 flex items-center gap-3"><span id="m-node-dot" class="status-dot offline shrink-0"></span><div><div class="text-[10px] text-slate-400 font-bold">节点服务</div><div id="m-node-status" class="text-xs font-bold text-slate-500">未连接</div></div></div>
    <div class="flex-1 glass rounded-xl p-3 border border-emerald-500/20 flex items-center gap-3"><span id="m-nezha-dot" class="status-dot offline shrink-0"></span><div><div class="text-[10px] text-slate-400 font-bold">哪吒探针</div><div id="m-nezha-status" class="text-xs font-bold text-slate-500">未连接</div></div></div>
</div>
<div class="space-y-2 p-4 bg-black/20 rounded-2xl border border-slate-800/50">
    <p class="text-xs text-slate-400 font-bold mb-2">核心配置</p>
    <input id="m-uuid" placeholder="UUID (自动生成)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-emerald-400 font-mono">
    <div class="grid grid-cols-2 gap-2"><input id="m-argo-domain" placeholder="ARGO_DOMAIN" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-argo-auth" placeholder="ARGO_AUTH" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
    <div class="grid grid-cols-2 gap-2"><input id="m-argo-port" placeholder="ARGO_PORT (默认8001)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-name" placeholder="NAME" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
</div>
<details class="group bg-black/20 rounded-2xl border border-slate-800/50 mt-2">
<summary class="flex justify-between items-center cursor-pointer list-none p-3"><span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">📡 哪吒 & 优选 & 多端口 (可选)</span><span class="transition group-open:rotate-180 text-slate-500 text-[10px]">▼</span></summary>
<div class="px-3 pb-3 space-y-2">
    <input id="m-nezha-server" placeholder="NEZHA_SERVER (v0: nz.com v1: nz.com:8008)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">
    <div class="grid grid-cols-2 gap-2"><input id="m-nezha-key" placeholder="NEZHA_KEY" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-nezha-port" placeholder="NEZHA_PORT (v1留空, v0填端口)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
    <p class="text-[9px] text-slate-600 -mt-1">💡 v1格式(带端口如:443)此处必须留空！v0才填agent端口</p>
    <div class="grid grid-cols-2 gap-2"><input id="m-cfip" placeholder="CFIP (默认skk.moe)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-cfport" placeholder="CFPORT (默认8443)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
    <div class="grid grid-cols-3 gap-2"><input id="m-hy2-port" placeholder="HY2_PORT" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-reality-port" placeholder="REALITY_PORT" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input id="m-tuic-port" placeholder="TUIC_PORT" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></div>
</div></details>
<div class="bg-black/60 rounded-xl p-3 h-40 overflow-y-auto font-mono text-[10px] border border-white/5 shadow-inner log-box mt-2" id="music-log-box"><div class="text-slate-500 opacity-50 text-center mt-12">等待操作...</div></div>
<div class="grid grid-cols-4 gap-2"><button id="music-btn-start" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold cursor-pointer">▶️ 启动</button><button id="music-btn-stop" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold cursor-pointer">⏹️ 停止</button><button id="music-btn-copy" class="bg-indigo-600/90 shadow-lg shadow-indigo-500/30 text-white py-2.5 rounded-xl text-xs font-bold cursor-pointer opacity-50">📋 提取</button><button id="music-btn-uninstall" class="toggle-btn off py-2.5 rounded-xl text-xs font-bold text-red-400 cursor-pointer">🗑️ 卸载</button></div>
</div>
</div>
</div>
</div>

<div id="modal-tavern" class="modal-overlay fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
<div class="modal-content glass rounded-3xl w-full max-w-2xl border border-amber-500/20 shadow-2xl p-8 relative max-h-[90vh] overflow-y-auto log-box">
<div class="flex justify-between items-center mb-6"><h2 class="text-2xl font-extrabold tracking-tight flex items-center gap-3"><span class="text-xl">🍺</span> 酒馆任务</h2><button class="close-tavern text-slate-400 hover:text-white text-2xl font-bold cursor-pointer">&times;</button></div>
<div class="bg-black/30 rounded-2xl p-4 border border-amber-500/10 mb-4">
<p class="text-xs text-amber-400 font-bold mb-3">➕ 创建新任务</p>
<div class="flex gap-3 items-center">
    <select id="new-task-type" class="select-dark rounded-xl px-4 py-2.5 text-xs text-white flex-1">
        <option value="cron">⏰ 定时访问</option>
        <option value="afk">🎮 AFK 模拟</option>
    </select>
    <button id="btn-add-task" class="btn-primary px-6 py-2.5 rounded-xl text-xs font-bold cursor-pointer shrink-0">➕ 创建</button>
</div>
</div>
<div id="tavern-task-list" class="space-y-4 mb-4"><div class="text-center text-slate-500 text-xs py-6 opacity-50">暂无任务，请点击上方创建</div></div>
<details class="group bg-black/30 rounded-2xl border border-amber-500/10">
<summary class="flex justify-between items-center cursor-pointer list-none p-4"><span class="text-xs font-bold text-amber-400 uppercase tracking-wider">🔑 全局认证配置</span><span class="transition group-open:rotate-180 text-slate-500 text-xs">▼</span></summary>
<div class="px-4 pb-4 space-y-2">
<form onsubmit="return false"><input id="tv-account" placeholder="账号 (Basic Auth)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></form>
<form onsubmit="return false"><input id="tv-password" type="password" placeholder="密码" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"></form>
<input id="tv-token" placeholder="Cookie 或 API Key (自动识别)" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">
<button id="btn-save-auth" class="btn-primary w-full py-2 rounded-xl text-xs font-bold cursor-pointer">💾 保存</button>
</div>
</details>
</div>
</div>

<script>
(function(){
var btn=document.getElementById('auth-btn'),inp=document.getElementById('auth-pwd'),scr=document.getElementById('auth-screen'),main=document.getElementById('main-content'),err=document.getElementById('auth-err');
function doAuth(){
    if(inp.value==='admin'){
        try{sessionStorage.setItem('pf_auth','1')}catch(e){}
        scr.style.display='none';
        main.style.display='';
        var wa=document.getElementById('welcome-audio');
        if(wa){wa.volume=.8;wa.play().catch(function(){});}
    }else{
        err.style.display='';inp.value='';setTimeout(function(){err.style.display='none'},2000)
    }
}
btn.onclick=doAuth;inp.onkeydown=function(e){if(e.key==='Enter')doAuth()};
try{if(sessionStorage.getItem('pf_auth')==='1'){scr.style.display='none';main.style.display='';var wa=document.getElementById('welcome-audio');if(wa){wa.volume=.8;wa.play().catch(function(){})}}}catch(e){}
})();
<\/script>

<script>
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function unitLabel(u){return{sec:'秒',min:'分钟',hour:'小时',day:'天',month:'月'}[u]||u}
var drafts={};
function saveDraft(b,f,v){if(!drafts[b])drafts[b]={};drafts[b][f]=v}
function getDraft(b,f,d){return(drafts[b]&&drafts[b][f]!==undefined)?drafts[b][f]:(d||'')}

function openAppCenter(){document.getElementById('modal-app-center').classList.add('active');showAppView('list')}
function closeAppCenter(){document.getElementById('modal-app-center').classList.remove('active')}
function openTavern(){document.getElementById('modal-tavern').classList.add('active');loadTavernData()}
function closeTavern(){document.getElementById('modal-tavern').classList.remove('active')}

function showAppView(v){var modal=document.getElementById('modal-app-center');modal.querySelectorAll('.view-section').forEach(function(e){e.classList.remove('active-view')});document.getElementById('view-'+v).classList.add('active-view');if(v==='ff')loadFFStatus();if(v==='music')loadMusicStatus()}

document.getElementById('btn-app-center').onclick=openAppCenter;
document.getElementById('btn-tavern').onclick=openTavern;
document.getElementById('btn-add-bot').onclick=async function(){await fetch('/api/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:document.getElementById('h').value,username:document.getElementById('u').value})});updateUI(true)};

document.getElementById('modal-app-center').addEventListener('click',function(e){
var t=e.target.closest('.nav-ff');if(t){showAppView('ff');return}
t=e.target.closest('.nav-music');if(t){showAppView('music');return}
t=e.target.closest('.nav-list');if(t){showAppView('list');return}
t=e.target.closest('.close-app-center');if(t){closeAppCenter();return}
});

document.getElementById('ff-btn-start').onclick=async function(){var p={FF_PASS:document.getElementById('ff-pass').value,FF_PORT:document.getElementById('ff-port').value,ARGO_DOMAIN:document.getElementById('ff-argo-domain').value,ARGO_AUTH:document.getElementById('ff-argo-auth').value};await fetch('/api/apps/firefox/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({params:p})});loadFFStatus()};
document.getElementById('ff-btn-stop').onclick=async function(){await fetch('/api/apps/firefox/stop',{method:'POST'});loadFFStatus()};
document.getElementById('ff-btn-uninstall').onclick=async function(){if(!confirm('确认卸载？'))return;await fetch('/api/apps/firefox/uninstall',{method:'DELETE'});loadFFStatus()};

document.getElementById('music-btn-start').onclick=async function(){
    var p={UUID:document.getElementById('m-uuid').value,ARGO_DOMAIN:document.getElementById('m-argo-domain').value,ARGO_AUTH:document.getElementById('m-argo-auth').value,ARGO_PORT:document.getElementById('m-argo-port').value,NAME:document.getElementById('m-name').value,NEZHA_SERVER:document.getElementById('m-nezha-server').value,NEZHA_PORT:document.getElementById('m-nezha-port').value,NEZHA_KEY:document.getElementById('m-nezha-key').value,CFIP:document.getElementById('m-cfip').value,CFPORT:document.getElementById('m-cfport').value,HY2_PORT:document.getElementById('m-hy2-port').value,REALITY_PORT:document.getElementById('m-reality-port').value,TUIC_PORT:document.getElementById('m-tuic-port').value};
    try{var r=await fetch('/api/apps/music/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({params:p})});var d=await r.json();if(!d.success&&d.msg)alert('❌ 启动失败: '+d.msg);loadMusicStatus();}catch(e){alert('❌ 请求失败');}
};
document.getElementById('music-btn-stop').onclick=async function(){await fetch('/api/apps/music/stop',{method:'POST'});loadMusicStatus()};
document.getElementById('music-btn-uninstall').onclick=async function(){if(!confirm('确认卸载？'))return;await fetch('/api/apps/music/uninstall',{method:'DELETE'});loadMusicStatus()};
document.getElementById('music-btn-copy').onclick=async function(){try{var r=await fetch('/api/apps/music/nodes');var d=await r.json();if(!d.success||!d.nodes){alert('❌ 未检测到节点文件');return}var text=d.nodes;if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);alert('✅ 已复制！')}else{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('✅ 已复制！')}}catch(e){alert('❌ 失败')}};

document.getElementById('btn-save-auth').onclick=async function(){var d={account:document.getElementById('tv-account').value,password:document.getElementById('tv-password').value,token:document.getElementById('tv-token').value};await fetch('/api/apps/tavern/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});alert('✅ 已保存')};

document.getElementById('btn-add-task').onclick=async function(){
    var type=document.getElementById('new-task-type').value;
    var name=type==='afk'?'AFK 模拟':'定时访问';
    var p={name:name,type:type,url:'',method:'GET',body:'',interval:type==='afk'?30:5,unit:type==='afk'?'sec':'min'};
    await fetch('/api/apps/tavern/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
    loadTavernData();
};

async function handleTaskAction(act,id){
    if(act==='start') await fetch('/api/apps/tavern/tasks/'+id+'/start',{method:'POST'});
    else if(act==='stop') await fetch('/api/apps/tavern/tasks/'+id+'/stop',{method:'POST'});
    else if(act==='delete'){if(!confirm('删除此任务？'))return;await fetch('/api/apps/tavern/tasks/'+id,{method:'DELETE'})}
    else if(act==='save-restart'){
        var card=document.querySelector('.task-card[data-task-id="'+id+'"]');if(!card)return;
        var name=card.querySelector('.task-name').value;
        var url=card.querySelector('.task-url').value;
        var method=card.querySelector('.task-method').value;
        var bodyEl=card.querySelector('.task-body');
        var body=bodyEl?bodyEl.value:'';
        var interval=card.querySelector('.task-interval').value;
        var unit=card.querySelector('.task-unit').value;
        var p={name:name,url:url,method:method,body:body,interval:interval,unit:unit};
        await fetch('/api/apps/tavern/tasks/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
        await fetch('/api/apps/tavern/tasks/'+id+'/stop',{method:'POST'}); 
        await fetch('/api/apps/tavern/tasks/'+id+'/start',{method:'POST'});
    }
    loadTavernData();
}

document.getElementById('modal-tavern').addEventListener('click',function(e){
var t=e.target.closest('.close-tavern');if(t){closeTavern();return}
var t2=e.target.closest('[data-task-act]');if(t2){handleTaskAction(t2.dataset.taskAct,t2.dataset.taskId);return}
});

async function loadTavernData(){
try{var r=await fetch('/api/apps/tavern/tasks');var d=await r.json();
renderTaskList(d.tasks);
if(d.auth){document.getElementById('tv-account').value=d.auth.account||'';document.getElementById('tv-password').value=d.auth.password||'';document.getElementById('tv-token').value=d.auth.token||''}
}catch(e){}
}

function renderTaskList(tasks){
var el=document.getElementById('tavern-task-list');
if(!tasks||tasks.length===0){el.innerHTML='<div class="text-center text-slate-500 text-xs py-6 opacity-50">暂无任务，请点击上方创建</div>';return}
var ae=document.activeElement;if(ae&&ae.closest&&ae.closest('.task-card')&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'||ae.tagName==='TEXTAREA'))return;
var sp={};el.querySelectorAll('.log-box[data-task-id]').forEach(function(box){sp[box.dataset.taskId]=box.scrollTop});
var html='';
tasks.forEach(function(t){
var icon=t.type==='afk'?'🎮':'⏰';
var badge=t.running?'<span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/20 text-emerald-400">运行中</span>':'<span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-slate-700 text-slate-400">离线</span>';

html+='<div class="task-card glass rounded-xl p-4 border border-cyan-500/20" data-task-id="'+t.id+'">';
html+='<div class="flex justify-between items-center mb-3"><div class="flex items-center gap-2"><span class="text-lg">'+icon+'</span><input class="task-name input-dark rounded-lg px-2 py-1 text-sm font-bold text-white w-32" value="'+escapeHtml(t.name)+'" placeholder="任务名称">'+badge+'</div>';
html+='<button data-task-act="delete" data-task-id="'+t.id+'" class="w-7 h-7 rounded-full bg-slate-800 hover:bg-red-600 text-slate-500 hover:text-white transition-colors flex items-center justify-center text-xs font-bold cursor-pointer">✕</button></div>';

html+='<div class="space-y-2 mb-3 p-3 bg-black/30 rounded-xl border border-white/5">';
html+='<div class="flex gap-2">';
html+='<select class="task-method select-dark rounded-lg px-3 py-2 text-xs text-white w-24">';
html+='<option value="GET"'+(t.method==='GET'?' selected':'')+'>GET</option>';
html+='<option value="POST"'+(t.method==='POST'?' selected':'')+'>POST</option>';
html+='</select>';
html+='<input class="task-url input-dark w-full rounded-lg px-3 py-2 text-xs text-white" value="'+escapeHtml(t.url)+'" placeholder="请求 URL (必填)">';
html+='</div>';
if(t.method==='POST'){
    html+='<textarea class="task-body input-dark w-full rounded-lg px-3 py-2 text-xs text-white h-16 font-mono" placeholder="POST Body (JSON格式)" style="resize:none">'+escapeHtml(t.body||'')+'</textarea>';
}
html+='<div class="flex gap-2 items-center"><span class="text-[10px] text-slate-400 shrink-0">间隔</span><input class="task-interval input-dark w-20 rounded-lg px-3 py-2 text-xs text-white" type="number" min="1" value="'+t.interval+'" placeholder="间隔"><select class="task-unit select-dark rounded-lg px-3 py-2 text-xs text-white flex-1"><option value="sec" '+(t.unit==='sec'?'selected':'')+'>秒</option><option value="min" '+(t.unit==='min'?'selected':'')+'>分钟</option><option value="hour" '+(t.unit==='hour'?'selected':'')+'>小时</option><option value="day" '+(t.unit==='day'?'selected':'')+'>天</option></select></div>';
html+='</div>';

html+='<div class="flex gap-2 mb-3">';
if(!t.running){html+='<button data-task-act="start" data-task-id="'+t.id+'" class="flex-1 bg-emerald-600/80 hover:bg-emerald-600 text-white px-3 py-2 rounded-lg text-[11px] font-bold cursor-pointer">▶️ 启动</button>';}
else{html+='<button data-task-act="stop" data-task-id="'+t.id+'" class="flex-1 bg-orange-600/80 hover:bg-orange-600 text-white px-3 py-2 rounded-lg text-[11px] font-bold cursor-pointer">⏹️ 停止</button>';}
html+='<button data-task-act="save-restart" data-task-id="'+t.id+'" class="flex-1 bg-blue-600/80 hover:bg-blue-600 text-white px-3 py-2 rounded-lg text-[11px] font-bold cursor-pointer">💾 保存并重启</button>';
html+='</div>';

html+='<div data-task-id="'+t.id+'" class="log-box bg-black/50 rounded-lg p-2 h-28 overflow-y-auto font-mono text-[10px] border border-white/5 shadow-inner">';
if(t.logs&&t.logs.length>0){t.logs.forEach(function(l){html+='<div class="mb-0.5 '+(l.color||'')+' flex"><span class="opacity-30 mr-1 shrink-0 select-none text-[9px]">['+l.time+']</span><span class="text-[10px]">'+l.msg+'</span></div>'});}
else{html+='<div class="text-slate-500 opacity-50 text-center text-[10px] mt-6">等待操作...</div>'}
html+='</div></div>';
});
el.innerHTML=html;
Object.keys(sp).forEach(function(id){var box=el.querySelector('.log-box[data-task-id="'+id+'"]');if(box)box.scrollTop=sp[id]});
}

async function loadFFStatus(){try{var r=await fetch('/api/apps/firefox/status');var d=await r.json();var R=d.running;document.getElementById('ff-btn-start').className='toggle-btn '+(R?'off opacity-50':'bg-emerald-600/90 shadow-lg shadow-emerald-500/30 text-white')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer';document.getElementById('ff-btn-stop').className='toggle-btn '+(R?'bg-orange-600/90 shadow-lg shadow-orange-500/30 text-white':'off opacity-50')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer';if(d.url){document.getElementById('ff-url-box').classList.remove('hidden');document.getElementById('ff-url-link').href=d.url;document.getElementById('ff-url-link').innerHTML='🔗 '+d.url}else{document.getElementById('ff-url-box').classList.add('hidden')}document.getElementById('ff-log-box').innerHTML=renderLogs(d.logs)}catch(e){}}

async function loadMusicStatus(){
try{
    var r=await fetch('/api/apps/music/status');var d=await r.json();var R=d.running;
    document.getElementById('music-btn-start').className='toggle-btn '+(R?'off opacity-50':'bg-emerald-600/90 shadow-lg shadow-emerald-500/30 text-white')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer';
    document.getElementById('music-btn-stop').className='toggle-btn '+(R?'bg-orange-600/90 shadow-lg shadow-orange-500/30 text-white':'off opacity-50')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer';
    var cb=document.getElementById('music-btn-copy');cb.className=(d.hasNodes?'bg-indigo-600/90 shadow-lg shadow-indigo-500/30 text-white':'bg-slate-700 text-slate-400 opacity-50')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer';
    document.getElementById('music-log-box').innerHTML=renderLogs(d.logs,12);
    
    var nodeDot=document.getElementById('m-node-dot'),nodeText=document.getElementById('m-node-status'),nezhaDot=document.getElementById('m-nezha-dot'),nezhaText=document.getElementById('m-nezha-status');
    if(d.hasNodes){nodeDot.className='status-dot online shrink-0';nodeText.className='text-xs font-bold text-emerald-400';nodeText.innerText='已生成'}else if(R){nodeDot.className='status-dot offline shrink-0';nodeText.className='text-xs font-bold text-yellow-400';nodeText.innerText='生成中'}else{nodeDot.className='status-dot offline shrink-0';nodeText.className='text-xs font-bold text-slate-500';nodeText.innerText='未连接'}
    
    if(d.nezhaActive){nezhaDot.className='status-dot online shrink-0';nezhaText.className='text-xs font-bold text-emerald-400';nezhaText.innerText='已激活'}else{nezhaDot.className='status-dot offline shrink-0';nezhaText.className='text-xs font-bold text-slate-500';nezhaText.innerText='未配置'}
    
    if(!document.getElementById('m-uuid').value){try{var ur=await fetch('/api/apps/music/uuid');var ud=await ur.json();document.getElementById('m-uuid').value=ud.uuid}catch(e){}}
}catch(e){}}

function renderLogs(logs,et){if(!logs||logs.length===0)return'<div class="text-slate-500 opacity-50 text-center mt-'+(et||16)+'">等待操作...</div>';return logs.map(function(l){return'<div class="mb-1 '+(l.color||'')+' flex"><span class="opacity-30 mr-2 shrink-0 select-none">['+l.time+']</span><span>'+l.msg+'</span></div>'}).join('')}

async function updateSystemStatus(){try{var r=await fetch('/api/system/status');var d=await r.json();document.getElementById('mem-percent').innerText=d.percent+'%';document.getElementById('mem-progress').style.width=d.percent+'%';var p=document.getElementById('mem-progress');p.className=parseFloat(d.percent)>80?"h-full bg-gradient-to-r from-red-500 to-orange-400 transition-all duration-700 rounded-full":"h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700 rounded-full"}catch(e){}}
async function uploadFile(b,i){if(!i.files[0])return;var f=new FormData();f.append('file',i.files[0]);var r=await fetch('/api/bots/'+b+'/upload',{method:'POST',body:f});alert(r.ok?'✅ 成功':'❌ 失败');i.value=''}
async function restartNow(id){await fetch('/api/bots/'+id+'/restart-now',{method:'POST'});updateUI(true)}
async function setTimer(id,v,u){await fetch('/api/bots/'+id+'/set-timer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:v,unit:u})});updateUI(true)}
async function savePto(id){var d={url:document.getElementById('url-'+id).value,id:document.getElementById('sid-'+id).value,key:document.getElementById('key-'+id).value,defaultDir:document.getElementById('ddir-'+id).value};await fetch('/api/bots/'+id+'/pto-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});updateUI(true)}
async function toggleGuard(id){await fetch('/api/bots/'+id+'/toggle-guard',{method:'POST'});updateUI(true)}
async function toggle(id,t){await fetch('/api/bots/'+id+'/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:t})});updateUI(true)}
async function removeBot(id){if(confirm('确认移除？')){await fetch('/api/bots/'+id,{method:'DELETE'});updateUI(true)}}

async function updateUI(force){
if(!force){var a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='SUMMARY'||a.tagName==='SELECT'||a.tagName==='TEXTAREA'||(a.closest&&a.closest('details[open]'))))return}
var r=await fetch('/api/bots');var d=await r.json();
var od=Array.from(document.querySelectorAll('details[open]')).map(function(e){return e.id});
var sp={};document.querySelectorAll('.log-box[data-bot-id]').forEach(function(e){sp[e.dataset.botId]=e.scrollTop});
var html='';
d.bots.forEach(function(b){
var pto=b.settings.pterodactyl||{};var on=b.status==='在线';
html+='<div class="glass rounded-3xl overflow-hidden border-t-4 '+(on?'border-emerald-500':'border-red-500')+' card-hover flex flex-col"><div class="p-6 flex-1 flex flex-col gap-4">';
html+='<div class="flex justify-between items-center"><div><div class="flex items-center gap-2.5"><h3 class="text-xl font-extrabold tracking-tight">'+escapeHtml(b.username)+'</h3><span class="px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1.5 '+(on?'bg-emerald-500/20 text-emerald-400':'bg-red-500/20 text-red-400')+'"><span class="status-dot '+(on?'online':'offline')+'"></span>'+b.status+'</span></div><p class="text-xs text-slate-500 mt-1 font-medium">'+escapeHtml(b.host)+':'+b.port+'</p></div><button data-act="remove" data-id="'+b.id+'" class="w-8 h-8 rounded-full bg-slate-800 hover:bg-red-600 hover:text-white text-slate-500 transition-colors flex items-center justify-center text-sm font-bold shadow-inner cursor-pointer">✕</button></div>';
html+='<div data-bot-id="'+b.id+'" class="log-box bg-black/60 rounded-2xl p-4 h-40 overflow-y-auto font-mono text-[11px] border border-slate-800/50 shadow-inner">';
b.logs.forEach(function(l){html+='<div class="mb-1.5 '+(l.color||'')+' flex"><span class="opacity-30 mr-2 shrink-0 select-none">['+l.time+']</span><span>'+l.msg+'</span></div>'});
html+='</div>';
html+='<div class="grid grid-cols-3 gap-2"><button data-act="toggle" data-id="'+b.id+'" data-type="ai" class="toggle-btn '+(b.settings.ai?'bg-blue-600/90 shadow-lg shadow-blue-500/30 text-white':'off')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer">👁️ AI</button><button data-act="toggle" data-id="'+b.id+'" data-type="walk" class="toggle-btn '+(b.settings.walk?'bg-emerald-600/90 shadow-lg shadow-emerald-500/30 text-white':'off')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer">👣 巡逻</button><button data-act="toggle" data-id="'+b.id+'" data-type="chat" class="toggle-btn '+(b.settings.chat?'bg-orange-600/90 shadow-lg shadow-orange-500/30 text-white':'off')+' py-2.5 rounded-xl text-xs font-bold cursor-pointer">💬 喊话</button></div>';
html+='<div class="bg-slate-900/60 p-4 rounded-2xl border border-slate-800/50"><div class="flex justify-between items-center mb-3"><h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider">重启序列</h4><span class="text-[10px] text-slate-500">下次: <span class="text-cyan-400 font-semibold">'+b.nextRestart+'</span></span></div><div class="grid grid-cols-2 gap-2 mb-3"><div><input id="min-'+b.id+'" type="number" placeholder="分钟" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><button data-act="set-timer" data-id="'+b.id+'" data-input="min-'+b.id+'" data-unit="min" class="mt-1.5 w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-xl text-[10px] font-bold transition-colors cursor-pointer">设定分钟</button></div><div><input id="hour-'+b.id+'" type="number" placeholder="小时" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><button data-act="set-timer" data-id="'+b.id+'" data-input="hour-'+b.id+'" data-unit="hour" class="mt-1.5 w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-xl text-[10px] font-bold transition-colors cursor-pointer">设定小时</button></div></div><button data-act="restart" data-id="'+b.id+'" class="btn-danger w-full py-2.5 rounded-xl text-xs font-bold uppercase active:scale-95 transition-all cursor-pointer">⚡ 立即重启</button></div>';
html+='<details id="pto-'+b.id+'" class="group"><summary class="flex justify-between items-center cursor-pointer list-none bg-slate-900/60 p-3 rounded-2xl border border-slate-800/50 hover:border-slate-700 transition-colors"><span class="text-xs font-bold text-slate-400 uppercase tracking-wider">🦖 翼龙同步</span><span class="transition group-open:rotate-180 text-slate-500 text-xs">▼</span></summary><div class="mt-2 space-y-2 p-3 bg-slate-900/60 rounded-2xl border border-slate-800/50">';
html+='<input data-draft="'+b.id+'|url" id="url-'+b.id+'" placeholder="面板地址" value="'+escapeHtml(getDraft(b.id,'url',pto.url))+'" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">';
html+='<div class="grid grid-cols-2 gap-2"><input data-draft="'+b.id+'|sid" id="sid-'+b.id+'" placeholder="服务器 ID" value="'+escapeHtml(getDraft(b.id,'sid',pto.id))+'" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white"><input data-draft="'+b.id+'|ddir" id="ddir-'+b.id+'" placeholder="目录" value="'+escapeHtml(getDraft(b.id,'ddir',pto.defaultDir))+'" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-emerald-400"></div>';
html+='<input data-draft="'+b.id+'|key" id="key-'+b.id+'" type="password" placeholder="API Key" value="'+escapeHtml(getDraft(b.id,'key',pto.key))+'" class="input-dark w-full rounded-xl px-3 py-2 text-xs text-white">';
html+='<div class="grid grid-cols-2 gap-2 pt-1"><button data-act="save-pto" data-id="'+b.id+'" class="bg-slate-800 hover:bg-slate-700 text-[10px] py-2.5 rounded-xl font-bold transition-colors cursor-pointer">💾 保存</button><button data-act="upload" data-id="'+b.id+'" class="btn-primary text-[10px] py-2.5 rounded-xl font-bold cursor-pointer">🚀 同步</button><input type="file" id="f-'+b.id+'" data-botid="'+b.id+'" class="hidden"></div>';
html+='<button data-act="toggle-guard" data-id="'+b.id+'" class="toggle-btn '+(pto.guard?'bg-indigo-600/90 shadow-lg shadow-indigo-500/30 text-white':'off')+' w-full py-2.5 rounded-xl text-[10px] font-bold mt-2 cursor-pointer">🛡️ 守护 '+(pto.guard?'开启':'关闭')+'</button>';
html+='</div></details></div></div>';
});
document.getElementById('list').innerHTML=html;
od.forEach(function(id2){var el=document.getElementById(id2);if(el)el.open=true});
document.querySelectorAll('.log-box[data-bot-id]').forEach(function(e){if(sp[e.dataset.botId]!==undefined)e.scrollTop=sp[e.dataset.botId]});
}

document.getElementById('list').addEventListener('click',function(e){
var el=e.target.closest('[data-act]');if(!el)return;
var act=el.dataset.act,id=el.dataset.id;
if(act==='toggle')toggle(id,el.dataset.type);
else if(act==='remove')removeBot(id);
else if(act==='restart')restartNow(id);
else if(act==='set-timer')setTimer(id,document.getElementById(el.dataset.input).value,el.dataset.unit);
else if(act==='save-pto')savePto(id);
else if(act==='toggle-guard')toggleGuard(id);
else if(act==='upload')document.getElementById('f-'+id).click();
});
document.getElementById('list').addEventListener('input',function(e){if(e.target.dataset.draft){var parts=e.target.dataset.draft.split('|');saveDraft(parts[0],parts[1],e.target.value)}});
document.getElementById('list').addEventListener('change',function(e){if(e.target.type==='file'&&e.target.dataset.botid)uploadFile(e.target.dataset.botid,e.target)});

setInterval(function(){updateUI(false);updateSystemStatus();var m1=document.getElementById('modal-app-center');if(m1&&m1.classList.contains('active')){if(document.getElementById('view-ff').classList.contains('active-view'))loadFFStatus();if(document.getElementById('view-music').classList.contains('active-view'))loadMusicStatus()}var m2=document.getElementById('modal-tavern');if(m2&&m2.classList.contains('active'))loadTavernData()},3000);
updateUI(true);
<\/script>
</body></html>`);
});

const PORT = process.env.SERVER_PORT || 3000;
app.listen(PORT, '0.0.0.0', function(){
    if(fsSync.existsSync(CONFIG_FILE)){
        try{
            var saved = JSON.parse(fsSync.readFileSync(CONFIG_FILE));
            saved.forEach(function(b){
                createSmartBot('bot_'+Math.random().toString(36).substr(2,5), b.host, b.port, b.username, b.logs||[], b.settings)
            })
        }catch(e){}
    }
    
    if(fsSync.existsSync(MUSIC_ENV_FILE) && fsSync.existsSync(path.join(MUSIC_DIR, 'musicd'))) {
        try {
            var musicParams = JSON.parse(fsSync.readFileSync(MUSIC_ENV_FILE, 'utf8'));
            startMusicCore(musicParams, true).catch(e => console.error('AutoStart Music Failed:', e));
        } catch(e) {}
    }
});
