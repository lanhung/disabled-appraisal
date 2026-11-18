# casdao 单卡部署

此配置在 RTX 5090 32GB 上运行 Qwen3.5-9B BF16，图片转录和文字抽取共用一个 vLLM 服务。
共享模型目录为 `/root/fshare/models/Qwen/Qwen3.5-9B`，无需复制模型权重。
服务使用 131072 token 上下文、最多 6 张图片、2 个并发序列，并关闭思考模式。

## 服务与访问

安装目录：`/opt/disabled-appraisal`。三个进程由实例已有的 Supervisor 管理，以独立的
`appraisal` 用户运行，断开 SSH 后继续运行。

| 进程 | 监听地址 | 用途 |
| --- | --- | --- |
| `appraisal-vllm` | `127.0.0.1:8000` | 需要 Bearer API Key 的模型接口 |
| `appraisal-backend` | `https://127.0.0.1:3301` | 事实抽取、证据核验和条款评估 |
| `appraisal-web` | `http://0.0.0.0:8080` | 两个网页及 `/api/`、`/v1/` 代理 |

在 casdao 控制台为该实例添加 **8080** 端口的映射，服务协议使用 **HTTP**（如需选择传输协议，
使用 TCP）。入口使用控制台生成的访问地址，不是 SSH 连接端口。映射后可访问该地址下的
`/analyst.lintsing.net/`、`/appraise.lintsing.net/` 和 `/api/health/ready`。
Nginx 使用相对重定向，适配平台入口的域名、HTTPS 和外部端口；后端和模型仍监听回环地址。

在需要访问网页的电脑上建立 SSH 隧道，连接参数使用项目根目录的私有 `casdao.env`：

```sh
ssh -N -L 8800:127.0.0.1:8080 -p <port> <userName>@<ip>
```

保持该终端运行，然后打开：

- 伤情程度：<http://127.0.0.1:8800/analyst.lintsing.net/>
- 伤残等级：<http://127.0.0.1:8800/appraise.lintsing.net/>
- 就绪检查：<http://127.0.0.1:8800/api/health/ready>
- 模型 API 基址：`http://127.0.0.1:8800/v1`

模型密钥存放在远程 `config/vllm.key`，后端配置存放在 `config/backend.env`；两者只允许
root 和服务账户读取，不进入源码包或前端。`casdao.env` 也已加入 Git 忽略规则。
SSH 隧道也可继续使用。公网入口须在 casdao 控制台创建映射后才能访问。

## 构建与安装

本地使用 Node.js 20.19+ 构建：

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix gemini
npm run build
tar -czf appraisal-release.tar.gz dist gemini/server.js gemini/lib gemini/data \
  gemini/package.json gemini/package-lock.json gemini/node_modules deploy/casdao
```

远程需要已有的 vLLM、Supervisor、Python/PyYAML，以及 `nginx`、`openssl`、`acl`。
将兼容的 Node Linux 可执行文件放入 `/opt/disabled-appraisal/bin/node`。
本次部署使用 Node 24.19.0、vLLM 0.24.0+cu129、PyTorch 2.11.0+cu129。

把源码包解压至 `/opt/disabled-appraisal/releases/<release-id>`，以 root 执行：

```sh
bash /opt/disabled-appraisal/releases/<release-id>/deploy/casdao/install.sh
```

安装器生成私有密钥及后端 TLS 证书，原子切换 `current`，保留旧的静态资源，更新进程配置并
重启后端和网页服务。模型配置变化时才重启 vLLM。内部 TLS 证书有效期一年，Nginx 校验证书。
更新前保留上一版本目录；回退时可重新运行上一版本的安装器。

## 运维

```sh
supervisorctl status appraisal-vllm appraisal-backend appraisal-web
supervisorctl restart appraisal-backend
supervisorctl tail appraisal-vllm
curl -f http://127.0.0.1:8080/api/health/ready
nvidia-smi
```

日志位于 `logs/`，配置位于 `config/`，编译缓存位于 `cache/`。
需要修改模型时，修改版本内的 `deploy/casdao/vllm.yaml`，再运行安装器。
默认安装器会重建后端配置；持久的配置变更应同步修改安装器中的设置。

## 本次验收

- 模型加载、鉴权、JSON Schema 输出以及网页服务就绪检查通过。
- 桌面和手机浏览器回归 28/28 通过；部署后的页面另行检查。
- 实机通过同一请求中的 40000 字符及 6 张合成中文报告图片，耗时 21.65 秒；6 页均完成转录，
  保留“未见右侧第8肋骨骨折”的否定信息，图片证据仍按待核验处理。
- 单元测试 361 项中 360 项通过。`tests/stability.test.js:145` 的既有 `opaque` 提示断言失败，
  已在未修改的 Git HEAD 中复现。
- 8 个合成文字案例全部成功返回 HTTP 200；其中 4 个案例的关键状态、等级和条款检查符合预期。
  T01、T02、T06、T08 返回 `insufficient`、`grade=null`，未达到文档预期的等级结论。
  这些结果受高等级候选复核门控影响，需要继续核对候选筛选与模型条件判断。
- 这次关键结果检查不等同于 `tests/HUMAN_EVALUATION.md` 的 100 分逐项人工评分。

接入时修复了 vLLM 不支持冗余 `propertyNames: {type: "string"}` 的兼容问题，并补齐了
模型省略可选事实 ID 时的审计 ID 分配，避免有效模型结果触发 HTTP 500。
