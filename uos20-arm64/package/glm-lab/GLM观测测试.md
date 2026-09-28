# GLM 观测测试容器

当前开发机上的测试服务镜像名是 `langchain-glm-lab:latest`，容器名是 `langchain-glm-agent`，监听 `8000`。内置身份模板按这个容器名和镜像名把它识别为待确认智能体。

AnySentry 本体不需要 Docker。这个测试容器需要目标机已安装 Docker。包内 `langchain-glm-lab-arm64.tar` 是 aarch64 镜像，在目标机加载，不访问外网安装依赖。

## 启动

```bash
cd /opt/anysentry/glm-lab
cp glm.env.example glm.env
vi glm.env
chmod +x start-glm-lab.sh
./start-glm-lab.sh
```

`glm.env` 至少填写 `GLM_API_KEY`。地址默认 `http://35.220.164.252:3888/v1`，模型默认 `glm-5.3`。

停止：

```bash
docker stop langchain-glm-agent
```

## curl

服务说明：

```bash
curl -sS http://127.0.0.1:8000/
```

当前会话：

```bash
curl -sS http://127.0.0.1:8000/sessions
```

触发时间、计算、天气和文本工具：

```bash
curl -sS -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"obs-1","message":"现在几点?帮我算一下 128*46,再查一下北京天气,最后把 LangChain 反转"}'
```

同一会话再问一次，用来观察记忆：

```bash
curl -sS -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"obs-1","message":"刚才那个乘法结果再加 1000 是多少?"}'
```

从别的机器访问时，把 `127.0.0.1` 换成目标机地址。Observer 看的是这台机器上的容器 `langchain-glm-agent`，不是 curl 所在的机器。
