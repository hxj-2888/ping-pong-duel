#!/usr/bin/env bash
# ============================================================
# 乒乓对决 ECS 部署脚本（Alibaba Cloud Linux / RHEL 系）
# 用法：把本文件连同 server.js、package.json、public/ 一起上传到
#       ECS（如 /root/ppd 目录），然后在 ECS 上执行：
#         cd /root/ppd && bash 部署到ECS.sh
# 完成后玩家访问 http://<ECS公网IP>:8765 即可游玩（低延迟公网联机）。
# ============================================================
set -e

PORT="${PORT:-8765}"
# 跨源联机白名单：客户端 ECS 线路固定连 wss://searchdelta.online/ws，而玩家常从
# Cloudflare 托管的 https://ping-pong-duel.pages.dev 打开页面后再切到 ECS 线路。
# 此时 Origin 与 Host 不相等，不配白名单会在 WebSocket 握手阶段被拒（连不上/反复重连）。
# 新增联机入口域名时追加到本变量即可（逗号分隔，不要带路径）。
WS_ALLOWED_ORIGINS="${WS_ALLOWED_ORIGINS:-https://searchdelta.online,https://ping-pong-duel.pages.dev}"

echo "== 1/4 安装 Node.js =="
if ! command -v node >/dev/null 2>&1; then
  (sudo dnf install -y nodejs npm 2>/dev/null || sudo yum install -y nodejs npm 2>/dev/null) || {
    echo "系统仓库无 Node，改用 NodeSource 官方源（Node 20 LTS）..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo dnf install -y nodejs
  }
fi
node -v && npm -v 2>/dev/null || true

echo "== 2/4 放行系统防火墙端口 $PORT =="
sudo firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 && sudo firewall-cmd --reload >/dev/null 2>&1 \
  || sudo iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || true

echo "== 3/4 注册 systemd 服务（开机自启 + 崩溃自动重启）=="
DIR="$(cd "$(dirname "$0")" && pwd)"
sudo tee /etc/systemd/system/pingpong-duel.service >/dev/null <<EOF
[Unit]
Description=Ping-Pong Duel online server
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=/usr/bin/node server.js
Environment=PORT=$PORT
Environment=WS_ALLOWED_ORIGINS=$WS_ALLOWED_ORIGINS
Environment=RECORDS_POST_LIMIT=20
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable pingpong-duel >/dev/null 2>&1
sudo systemctl restart pingpong-duel
sleep 1
sudo systemctl status pingpong-duel --no-pager | head -8 || true

echo "== 4/4 完成 =="
echo "  服务器已启动：http://<ECS公网IP>:$PORT"
echo "  跨源联机白名单：$WS_ALLOWED_ORIGINS"
echo "  ⚠ 重要：还需在「阿里云控制台 → 本实例 → 安全组」放行 TCP $PORT 入方向，否则外部连不上！"
echo "  验证：curl -s http://127.0.0.1:$PORT/api/info"
echo ""
echo "  ⚠ 走 ECS 线路（wss://）前，务必按 部署说明.txt 的「六、HTTPS + nginx 反代」"
echo "    配置 nginx 与白名单，否则网页版会因混合内容/握手被拒而连不上（拉不了手）。"
echo "    注意：nginx 里不要写 proxy_set_header Origin \"\"; —— 那会关掉 CSWSH 防护。"
