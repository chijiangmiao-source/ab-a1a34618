# 深空滑翔器离线姿态事件封存链 —— Compose 镜像
#
# 多阶段：
#   deps   —— 安装运行时依赖（Playwright 供 verify 服务使用）
#   web    —— 页面及健康响应宿主（生产镜像，默认目标）
#   verify —— 一次运行后退出的核验服务：构建前端、规则测试、HTTP 冒烟、浏览器中断演练
#
# 构建时构建参数：
#   NODE_IMAGE=node:20-bookworm-slim（评审环境若有镜像镜像站可覆盖）
#   PLAYWRIGHT_BROWSERS=/home/node/.cache/ms-playwright

ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# verify 需要真实浏览器与系统库；web 目标稍后会甩掉浏览器层
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --include=dev && \
    npx playwright install --with-deps chromium

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
# server.mjs 与构建脚本只使用 Node 内置模块，web 镜像无需任何 node_modules
COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
# 确保交付物里 core 已发布到 public/vendor/core
RUN node scripts/build-web.mjs
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# 非 root
USER node
CMD ["node", "src/server.mjs"]

FROM deps AS verify
WORKDIR /app
ENV PORT=8080
ENV HOST=0.0.0.0
COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
# 一次运行后退出，以退出码报告（npm run verify 会先构建前端）
CMD ["npm", "run", "verify"]
