# 通用 Docker 镜像（自有服务器/其他平台可用；Render 用 render.yaml 不需要它）
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
