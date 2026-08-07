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
echo "  ⚠ 重要：还需在「阿里云控制台 → 本实例 → 安全组」放行 TCP $PORT 入方向，否则外部连不上！"
echo "  验证：curl -s http://127.0.0.1:$PORT/api/info"
