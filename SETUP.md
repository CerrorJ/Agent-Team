## 本地环境

本机需要 Node 22+、pnpm，以及部署 CLI 依赖的 pm2：

```bash
node --version
pnpm --version
npm install -g pm2
```

确认 Claude Code 与 Codex 已经安装并完成凭证配置：

```bash
claude --version
codex --version
```

## 生产构建与本地常驻

```bash
pnpm install
pnpm build
pnpm agent-team doctor
pnpm agent-team start
pnpm agent-team status
pnpm agent-team logs
```

开机自启：

```bash
pm2 startup
```

按提示执行输出里的命令即可。

## 国内 ECS 部署

### 准备服务器

购买一台 Linux VPS（Ubuntu/Debian），按下面命令装好 Node.js 22+、pnpm 和 pm2：

```bash
sudo dnf install -y git
git clone https://gitee.com/mirrors/nvm.git ~/.nvm && cd ~/.nvm && git checkout `git describe --abbrev=0 --tags`
sudo sh -c 'echo ". ~/.nvm/nvm.sh" >> /etc/profile && echo "export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node" >> /etc/profile'
source /etc/profile
nvm install 22
npm install -g pnpm pm2
```

### 上传代码与配置

在服务器上克隆项目并安装依赖：

```bash
git clone <你的仓库地址> agent-team
cd agent-team
pnpm install
```

把 `.env` 与 `config/bots.json` 放到服务器项目目录，只进运行环境，不进 git。再安装并配置 Claude Code / Codex，确认命令和凭证可用：

```bash
claude --version
codex --version
```

### 在服务器终端部署

本地不需要远程操作。登录 ECS 终端后，把本地这一套重新执行一遍：

```bash
pnpm install
pnpm build
pnpm agent-team doctor
pnpm agent-team start
```

设置开机自启：

```bash
pm2 startup
```

按提示执行输出里的命令即可。

后续更新同样在 ECS 终端执行：

```bash
git pull
pnpm install
pm2 restart agent-team
```
