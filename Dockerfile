FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN mkdir -p /src/server/internal/webui/dist && npm run build

FROM golang:1.23-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /src/server/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -o /paperfarm ./cmd/paperfarm

FROM gcr.io/distroless/static-debian12
COPY --from=server /paperfarm /paperfarm
ENV PAPERFARM_DATA=/data
EXPOSE 8080
ENTRYPOINT ["/paperfarm", "serve"]
