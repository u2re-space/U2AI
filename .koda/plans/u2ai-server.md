# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/server (0.3.xx)

> Актуальный статус: **все 19 шагов плана выполнены**, пакет готов к релизу (каркас, конфиг, OpenAI-слой, протокол, WebSocket-сервер, хаб шины, инструменты файловой системы, терминал, контекст и сканирование workspace, MCP-сервер, MCP-клиент, роли и серверный агент, Tab-autocomplete с HTTP- и WebSocket-мостом, обработка инструментов в шине, HTTP-API для расширений, внешние AI-сервисы и утилиты, мост из монолита, тесты, README и релиз-чеклист). После релиза добавлен шаг 20 — транспорты stdio в отдельных модулях.
> Рабочий дом переносимого кода: `submodules/u2ai-server/`.
> Репозиторий: <https://github.com/u2re-space/u2ai-server> (remote настроен, пуш не делаем).
>
> Наследники предыдущих шагов: `submodules/u2ai-decomposer/` (`@u2ai/decomposer`),
> `submodules/u2ai-images/` (`@u2ai/images`), `submodules/u2ai-measurer/` (`@u2ai/measurer`) —
> из них берутся каркас CLI, конфиг-система, openai-слой и агентный слой, чтобы четыре
> пакета не расходились по стилю.
> Клиентская сторона: `C:\Projects\VSCodeExtension` (`https://github.com/u2re-space/VSCodeExtension`),
> спека протокола — `docs/superpowers/specs/2026-10-15-agent-websocket-design.md`.

---

## 0. Цели и рамки

**Цель:** выделить из монолитного CLI `ai` серверную часть — шину команд `ai serve`,
WebSocket-транспорт, HTTP-мост `/v1/complete`, MCP-клиент и агентные инструменты
(доступ к FS, терминал, команды, workspace) — в самостоятельный сервис `ai-serve`
(`@u2ai/server`) со своим конфигом `~/.ai-serve`, который умеет:

1. отдавать наружу инструменты через MCP (сервер) — **приоритет v0.3**;
2. принимать подключения от расширений (VSCode и других) по протоколу `ai-serve`;
3. отдавать tab-autocomplete по HTTP/WS;
4. запускать и обслуживать другие AI-сервисы и утилиты, подключённые по `ai-serve` или MCP;
5. исполнять простые функции как ИИ-агент.

**Рамки нового пакета:**

| Параметр | Значение |
|---|---|
| Имя пакета | `@u2ai/server` |
| Бинарь | `ai-serve` (`bin/ai-serve.{js,cmd,ps1,sh}`) |
| Репозиторий | <https://github.com/u2re-space/u2ai-server> |
| Версия | 0.3.0-alpha |
| Конфиг | `~/.ai-serve/` — каталог: `config.json`, `mcp.json`, `skills/`, `logs/` (оверрайд `AI_SERVE_HOME`) |
| Префикс env | `AI_SERVE_*` (совместимость с `OPENAI_*`, `AI_MODEL`, `OPENAI_BASE_URL`) |
| Runtime | Node.js >= 26, ESM, без SDK (чистый `fetch`) |
| Зависимости | `@modelcontextprotocol/node` (MCP-клиент); серверная часть MCP — свой JSON-RPC без SDK |
| Транспорт | свой WebSocket-сервер поверх `node:http` (как в монолите), лимит кадра 1 МиБ |

**Приоритеты (решения пользователя):**

| Вопрос | Решение |
|---|---|
| Приоритет v0.3 | MCP-сервер с инструментами |
| Удалённый доступ | Отдельным поздним этапом (шаг-late) |
| Судьба монолита | Перенести в пакет, в монолите оставить мост |

**Что переносим, а что — нет:**

| Переносим | Не переносим |
|---|---|
| Шина команд `ai serve`: хаб, `hello`/`ready`, запуск `ask\|run\|chat\|image`, `run.started`/`run.ended` | Пайплайн монолитного `ai` целиком (команды остаются в монолите) |
| WebSocket-сервер и протокол кадров, лимит 1 МиБ, ping/idle | Каналы `ai channels`, Telegram, jobs, background- режимы |
| HTTP-мост `/v1/complete` и `/v1/structure` (второй — как заглушка) | `src/channels/*`, `src/jobs/*` |
| Агентные инструменты: FS, терминал, команды, workspace-скан | Инструменты картинок, браузер, десктоп, метрики, декомпозиция |
| MCP-клиент (stdio + HTTP) с конфигом серверов | MCP как *функция монолита* — переносится в пакет, в монолите мост |
| Роли серверного агента: анализ, планирование, исполнение, подсказки | Роли монолита (кодер, архитектор, стилист, ревьюер) — остаются в монолите |
| Токен и файл `serve.json` (`~/.ai-serve/serve.json`), режим `0600` | Каналы `ai channels`, галерея картинок, замена GPTunnel |
| Протокол `ai-serve` как отдельный контракт (кадры, лимиты) | Транспортные детали редактора (Tab, inline completion) — это зона расширения |

**Карта источников монолита:**

| Файл монолита | Файл нового пакета | Что забираем |
|---|---|---|
| `src/server/protocol.js` | `src/server/ws.js` | WebSocket-сервер: кадры, маска, ping, idle, лимит 1 МиБ |
| `src/server/hub.js` | `src/server/u2ai.js` | хаб: запуск, подписки, approve/question, `tool.request`, `processing.*` |
| `src/server/publish.js` | `src/shared/encoder.js` | упаковка кадров и broadcast |
| `src/commands/serve.js` | `src/cli.js`, `src/server/http.js` | `startServe`, `serve.json`, маппинг полей `start` в значения команд |
| `src/complete/server.js` | `src/server/http.js` | HTTP-мост с проверкой токена |
| `src/complete/complete.js`, `src/complete/context.js` | `src/agent/autocomplete.js` | сбор контекста файла, окно 262144/900000 байт, промпт дополнения |
| `src/complete/ws.js` | `src/shared/decoder.js` | разбор клиентских кадров (используется и в шине) |
| `src/mcp/client.js`, `src/mcp/frame.js`, `src/mcp/session.js` | `src/client/mcp.js`, `src/client/node.js` | MCP-клиент: `initialize`, `tools/list`, `tools/call`, протоколы `2025-06-18`/`2025-03-26`/`2024-11-05` |
| `src/mcp/servers.js` | `src/client/proxy.js` | нормализация описаний MCP-серверов, прокси-имена инструментов |
| `src/agent/fs-tools.js` | `src/tools/filesystem.js` | `listFiles`, `readTextFile`, `searchFiles`, `writeTextFile`, `replaceInFile`, `deleteFile`, `makeDirectory`, `copyPath` |
| `src/agent/shell.js` | `src/tools/terminal.js` | `runCommand`, `runProgram`, оболочки, `sshPlan` (отложенный этап) |
| `src/agent/file-commands.js` | `src/tools/tools.js` | пакетные команды файлов, `FILE_COMMANDS_SCHEMA` |
| `src/agent/command-risk.js` | `src/tools/tools.js` | оценка риска команды, approve-категории |
| `src/agent/workspace-scan.js` | `src/tools/context.js` | карта workspace, `parseJsonc`, html-entry, формат карточки |
| `src/agent/paths.js` | `src/agent/access.js` | пути внутри корня, запрет секретов |
| `src/agent/tool-specs.js`, `src/agent/tools.js` | `src/tools/tools.js`, `src/tools/cache.js` | каталог инструментов, `toolDefinitions`, категории, кэш результатов |
| `src/core/config*.js` | `src/config/*` | ключи конфига и валидация |
| `src/openai/*` | `src/openai/*` | клиент, fallback систем и моделей, решения, батчи |
| `src/roles/*` (серверные роли) | `src/roles/*` | анализ, директор, исполнитель, подсказчик, инструментальщик |

**Скелет нового пакета (уже размечен в `submodules/u2ai-server/src/`):**

```
src/agent/     access.js autocomplete.js callable.js context.js remote.js
src/cli/       colors.js compatibility.js doctor.js parser.js
src/client/    fetch.js http.js mcp.js proxy.js stdio.js
src/config/    constants.js defaults.js parser.js
src/model/     profiles.js
src/openai/    batch.js chat.js client.js completions.js decision.js fallback.js fetch.js http.js responses.js
src/roles/     analyzer.js director.js executor.js suggester.js tooler.js
src/server/    http.js mcp.js stdio.js u2ai.js ws.js
src/shared/    decoder.js encoder.js protocol.js
src/tools/     cache.js context.js filesystem.js suggest.js terminal.js tools.js transfer.js
```

**Поверхность CLI `ai-serve`:**

| Команда | Что делает |
|---|---|
| `ai-serve serve [--port n]` | поднять шину `ai-serve`, HTTP-мост и MCP-сервер; пишет `serve.json` |
| `ai-serve mcp [--stdio\|--http] [--port n]` | MCP-сервер с инструментами: stdio (по умолчанию) или HTTP |
| `ai-serve tools [--json]` | список инструментов пакета (имя, категория, риск, схема) |
| `ai-serve agent "<task>" [--cwd d]` | разовая задача как ИИ-агент (роль + инструменты) |
| `ai-serve complete --file f --line n` | одноразовое дополнение из командной строки |
| `ai-serve services` | список подключённых внешних сервисов (ai-serve и MCP) и их состояние |
| `ai-serve config` | показать разрешённый конфиг (секреты укорочены) |
| `ai-serve doctor` | проверка окружения: Node, конфиг, ключи, порт, доступность сервисов |

**Контракт `ai-serve` (совпадает с текущим поведением `ai serve`):**

| Событие | Кадр |
|---|---|
| Приветствие | клиент → `{ type: "hello", role: "client", token }`; сервер → `{ type: "ready", runs }` |
| Запуск | `{ type: "start", command, prompt, cwd, approve, …~40 полей }` |
| Продолжение чата | `{ type: "input", runId, text }` |
| Отмена | `{ type: "cancel", runId }` |
| Подтверждение | `{ type: "approve", requestId, decision }` (`yes\|no\|always\|abort`) |
| Ответ на вопрос | `{ type: "answer", requestId, text }` |
| События прогона | `text.delta`, `reasoning.delta`, `tool.exec.start`, `tool.exec.done`, `warning`, `error`, `image.saved`, `response.done` |
| Захват обработки | `processing.claim`, `processing.claimed`, `processing.held`, `processing.released` |
| Запрос инструмента | `tool.request` → `tool.result` |

`approve` по умолчанию `ask`; режимы: `ask\|read\|write\|all`. `background`, `detach`, `job` в кадре `start` отклоняются.
Токен генерирует сервер, флагом не задаётся; пишется в `~/.ai-serve/serve.json` вместе с `pid` и `url`.

---

## 1. Шаги

### step-1 — Каркас пакета и лаунчеры
- [x] `package.json` (`@u2ai/server`, бинарь `ai-serve`, Node >= 26, ESM, зависимости)
- [x] `bin/ai-serve.{js,cmd,ps1,sh}`
- [x] `index.js` — публичный точечный вход
- [x] `scripts/check-syntax.mjs` — разбор всех файлов пакета
- [x] `.gitignore` (без `package-lock.json`)
- [x] Каркас каталогов `src/{agent,cli,client,config,model,openai,roles,server,shared,tools}`
- [x] `src/cli.js`, `src/cli/{parser,colors,compatibility}.js`, `src/help.js`, `src/index.js` — разбор
      argv, коды возврата, тексты справки; команды пока отвечают «not built yet»
- [x] Проверка: `npm run check` (51 файл), `npm test`, `ai-serve --help`, `ai-serve --version`

### step-2 — Система конфигурации `~/.ai-serve`
- [x] `src/config/constants.js` — enum'ы (режимы approve, категории инструментов, режимы MCP, роли)
- [x] `src/config/defaults.js` — дефолты: API, порт, лимиты, инструменты, MCP-серверы, пути, роли
- [x] `src/config/parser.js` — разбор `config.json` и `mcp.json`, `{{env:}}`/`{{file:}}`
- [x] `src/config/index.js` — `loadConfig`, `ensureConfigFile`, `redactConfig`, пути `~/.ai-serve`
- [x] `src/config/validate.js` — проверки с русскими сообщениями (порядок из `u2ai-measurer`)
- [x] env-префикс `AI_SERVE_*` (совместимость с `OPENAI_*`, `AI_MODEL`)
- [x] `src/config/{env,merge,paths}.js` — env→поля, глубокое слияние, пути дома
- [x] `src/config.js` — публичная поверхность конфига
- [x] `src/cli.js` — команда `config` печатает разрешённый конфиг с укороченными секретами
- [x] `test/config.test.js` — 16 тестов: приоритеты, плейсхолдеры, русские сообщения

### step-3 — OpenAI-слой
- [x] `src/openai/{fetch,http}.js` — транспорт на чистом `fetch`
- [x] `src/openai/responses.js` — тело Responses-запроса, `parseResponse`, `parseJsonText`
- [x] `src/openai/chat.js` — запасной транспорт Chat Completions
- [x] `src/openai/fallback.js` — `fallbackWorthy`, `modelRefusal`, цепочка систем и моделей
- [x] `src/openai/client.js` — ротация бэкендов, ретраи, `responses.create`
- [x] `src/openai/{completions,batch,decision}.js` — батчи, решения, алиасы
- [x] `src/model/profiles.js` — профили моделей, усилие reasoning, лимиты контекста
- [x] `test/openai.test.js` — 53 теста: тело запроса, разбор ответа, fallback, бэкенды,
      чат-транспорт, решения, батчи, профили моделей

### step-4 — Протокол `ai-serve`: кадры и кодирование
- [x] `src/shared/protocol.js` — константы протокола, лимиты кадра (1 МиБ), окно дополнения (262144/900000 байт)
- [x] `src/shared/encoder.js` — сборка кадров, `sanitizeValue` для исходящих значений
- [x] `src/shared/decoder.js` — разбор входящих кадров, валидация `start`/`input`/`approve`/`answer`/`complete`
- [x] `test/protocol.test.js` — границы окна, отклонение `background|detach|job`, битый JSON

### step-5 — WebSocket-сервер и файл `serve.json`
- [x] `src/server/ws.js` — WebSocket поверх `node:http`: рукопожатие, маска, ping, idle, лимит кадра
- [x] `src/server/http.js` — HTTP-часть на том же порту: `/health`, `/v1/complete`, `/v1/structure`, `/v1/tools`
- [x] `src/server/serve.js` — время жизни сервера: токен, `serve.json` (`pid`, `url`, `token`, `0600`),
      удаление файла при остановке, отказ «сервер уже работает» по живому `pid`
- [x] `src/cli.js` — команда `serve`: `--port`, запись `~/.ai-serve/serve.json`, удаление при остановке
- [x] `test/serve.test.js` — 19 тестов: рукопожатие, `serve.json`, занятый порт, живой `pid`, `/health`, токен

### step-6 — Хаб шины
- [x] `src/server/u2ai.js` — запуск прогона, подписки на события, `run.started`/`run.ended`, `run.event`
- [x] `src/server/u2ai.js` — approve/question: `approval.request`, `question.request`, ожидание решения
- [x] `src/server/u2ai.js` — `waitInput` для продолжения чата
- [x] `src/server/u2ai.js` — `attachConnection`: разбор кадров клиента, `subscribe`/`unsubscribe`, `cancel`, `ping`
- [x] `test/hub.test.js` — 21 тест: жизненный цикл прогона, approve, вопрос, ввод, отмена, подписки

### step-7 — Инструменты файловой системы
- [x] `src/agent/access.js` — корень доступа, пути внутри корня, запрет секретов
- [x] `src/tools/filesystem.js` — `listFiles`, `readTextFile`, `searchFiles`, `writeTextFile`, `replaceInFile`, `deleteFile`, `makeDirectory`, `copyPath`
- [x] `src/tools/tools.js` — каталог инструментов: имя, описание, схема параметров, категория, риск
- [x] `src/shared/format.js` — `formatBytes`, `formatDuration`, `truncateText`
- [x] `test/filesystem.test.js` — 47 тестов: корень доступа, секреты, список, чтение, поиск, запись, замена, удаление, копирование, схемы

### step-8 — Терминал и команды
- [x] `src/tools/terminal.js` — `runCommand`, `runProgram`, оболочки (`powershell`, `pwsh`, `cmd`, `bash`, `sh`, `zsh`), таймауты, лимит вывода
- [x] `src/tools/command-risk.js` — оценка риска текста команды, переписывание опасных формулировок
- [x] `src/tools/file-commands.js` — `FILE_COMMANDS_SCHEMA`, пакет `fs:read` / `fs:write` / `fs:list`
- [x] `src/tools/cache.js` — кэш результатов инструментов в рамках прогона
- [x] `src/tools/tools.js` — каталог: `run_command`, `run_script`, категория `exec`, риск `high`
- [x] `test/terminal.test.js` — 30 тестов: запуск, таймаут, усечение вывода, отмена, секреты окружения, риск, пакет, кэш

### step-9 — Контекст и сканирование workspace
- [x] `src/tools/context.js` — карта workspace, `parseJsonc`, html-entry, формат карточки
- [x] `src/agent/context.js` — сбор контекста для роли: файлы, `AGENTS.md`, упоминания `@file`
- [x] `src/tools/suggest.js` — подсказки путей и команд по контексту
- [x] `src/tools/tools.js` — каталог: `scan_workspace`, `collect_context`, `suggest` (группа `workspace` / `suggest`)
- [x] `test/context.test.js` — 33 теста: карта проекта, разбор jsonc, html-entry, упоминания, `AGENTS.md`, подсказки

### step-10 — MCP-сервер (приоритет v0.3)
- [x] `src/server/mcp.js` — JSON-RPC 2.0 без SDK: `initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`
- [x] Режимы: stdio (по умолчанию) и HTTP (`--http [--port n]`) с тем же токеном, что и шина
- [x] `src/server/mcp.js` — экспорт всех инструментов пакета (FS, терминал, контекст) наружу
- [x] Таймауты вызова, отмена (`notifications/cancelled`), понятные тексты ошибок
- [x] `src/server/serve.js` — эндпоинт `/mcp` на порту шины с тем же токеном
- [x] `src/cli.js` — команда `mcp`: stdio по умолчанию, HTTP с `--http`
- [x] `test/mcp.test.js` — 28 тестов: `initialize` → `tools/list` → `tools/call`, ресурсы, промпты, таймаут, отмена, оба транспорта

### step-11 — MCP-клиент
- [x] `src/client/mcp.js` — `initialize`, `tools/list`, `tools/call`; протоколы `2025-06-18`, `2025-03-26`, `2024-11-05`
- [x] `src/client/node.js` — stdio-транспорт, запуск процесса, таймауты
- [x] `src/client/http.js`, `src/client/fetch.js` — HTTP-транспорт MCP
- [x] `src/client/proxy.js` — нормализация описаний серверов, прокси-имена инструментов (`server__tool`)
- [x] `src/config/defaults.js` — список MCP-серверов по умолчанию (`mcpServers`, формат записи)
- [x] `test/mcp-client.test.js` — 16 тестов: подъём локального stdio-сервера, обёртка имён, серверы HTTP и битые серверы

### step-12 — Роли и серверный агент
- [x] `src/roles/analyzer.js` — разбор задачи и проекта
- [x] `src/roles/director.js` — план работ
- [x] `src/roles/executor.js` — исполнение шагов плана
- [x] `src/roles/tooler.js` — выбор и вызов инструментов
- [x] `src/roles/suggester.js` — ответы и подсказки по контексту
- [x] `src/roles/index.js` — цикл роли с инструментами, схема ответа, лимит ходов
- [x] `src/agent/callable.js` — «простые функции как ИИ-агент»: одношаговая задача без плана
- [x] `src/tools/tools.js` — `toolAllowed`: единая проверка прав инструмента для ролей и MCP
- [x] `src/cli.js` — команда `agent`: агент целиком (`--role analyzer|director|executor|tooler|suggester`)
- [x] `test/roles.test.js` — 22 теста: настройки роли, разбор задачи, план, выбор и вызов инструмента, шаги плана, лимит ходов, callable

### step-13 — Tab-autocomplete
- [x] `src/agent/autocomplete.js` — сбор окна документа (до 262144 байт; иначе строки `line-200…line+50`), деление окна при >900000 байт
- [x] `src/agent/autocomplete.js` — промпт дополнения, чистка вставки (`stripCompletion`, `fitInsertion`, `acceptInsertion`, `stripDoubledClosers`)
- [x] `src/agent/autocomplete.js` — `AutocompleteError` с кодом `line_too_long` на строке курсора больше 512 КиБ
- [x] `src/server/http.js` — `POST /v1/complete` (проверка токена), `WS /v1/complete?token=` для расширения
- [x] `src/server/u2ai.js` — `attachCompletionSocket`: сокет дополнения без `hello`, кадр `complete` → `completion`
- [x] `src/server/ws.js` — запрос апгрейда передаётся в обработчик соединения (`req`)
- [x] `src/server/serve.js` — маршрут `/v1/complete` уходит в мост дополнения, токен проверяется
- [x] `src/cli.js` — команда `complete`: разовое дополнение файла (`--file`, `--line`, `--language`)
- [x] `test/autocomplete.test.js` — 19 тестов: окно, курсор в срезе, отказ на гигантской строке, чистка вставки, HTTP- и WebSocket-мост

### step-14 — Обработка инструментов в шине
- [x] `src/server/u2ai.js` — `tool.request` → `tool.result`, таймаут запроса (120 с, `limits.toolTimeoutMs`)
- [x] `src/server/u2ai.js` — `processing.claim` / `processing.claimed` / `processing.held` / `processing.released`
- [x] `src/server/u2ai.js` — `requestTool` и `runTool`: держатель отвечает, иначе сервер исполняет инструмент сам
- [x] `src/tools/tools.js` — исполнение запроса инструмента по имени и аргументам, категории approve (`ask`/`read`/`write`/`all`)
- [x] `src/tools/tools.js` — `TOOL_ALIASES`: имя `replace_text` монолита ведёт к `replace_in_file`
- [x] `src/shared/protocol.js`, `src/shared/decoder.js` — кадры `processing.claim` и `tool.result`, проверка полей
- [x] `test/processing.test.js` — 19 тестов: захват обработки, маршрутизация запроса, ответ, таймаут, локальное исполнение

### step-15 — HTTP-API для расширений
- [x] `src/server/http.js` — `GET /health`, `GET /v1/tools`, `POST /v1/complete`, `POST /v1/structure` (заглушка), `GET /v1/serves`
- [x] Токен в заголовке `Authorization: Bearer` и в query; без токена — 401
- [x] `src/server/http.js` — CORS для локальных расширений, лимит тела запроса
- [x] `src/server/serve.js` — `/v1/serves`: этот сервер и внешние сервисы из конфига
- [x] `src/cli.js` — команда `tools`: список инструментов пакета с категорией и риском
- [x] `test/http.test.js` — 21 тест: маршруты, коды, проверка токена, CORS, лимит тела

### step-16 — Внешние AI-сервисы и утилиты
- [x] `src/client/proxy.js` — запуск и сопровождение внешних процессов по протоколу `ai-serve`
- [x] `src/client/proxy.js` — подключение внешних MCP-серверов как источников инструментов
- [x] `src/cli.js` — команда `services`: список, состояние, адреса, токены
- [x] Регистрация внешних сервисов в `~/.ai-serve/mcp.json` и `config.json`
- [x] `test/services.test.js` — подъём внешнего `ai-serve`, чтение `serve.json`, обрыв

### step-17 — Мост из монолита
- [x] В монолите `ai serve` делегирует поднятие `@u2ai/server`, если пакет установлен; иначе — прежнее поведение
- [x] В монолите `ai` команда `mcp` (если появится) — тонкий клиент к `ai-serve mcp`
- [x] Совместимость: тот же `serve.json`-контракт, тот же порт, тот же токен
- [x] Проверка: монолитный `ai serve` и `ai-serve serve` не конфликтуют по порту

### step-18 — Тесты
- [x] `test/config.test.js` — конфиг, валидация, русские сообщения
- [x] `test/protocol.test.js`, `test/hub.test.js`, `test/serve.test.js` — шина и запуск
- [x] `test/filesystem.test.js`, `test/terminal.test.js`, `test/context.test.js` — инструменты
- [x] `test/mcp.test.js`, `test/mcp-client.test.js` — MCP в обе стороны
- [x] `test/http.test.js`, `test/autocomplete.test.js`, `test/processing.test.js` — HTTP, дополнение, обработка
- [x] `test/roles.test.js` — роли и агентный цикл
- [x] `test/openai.test.js` — слой OpenAI: Responses, Chat Completions, откат, поток
- [x] `test/services.test.js` — внешние сервисы и MCP-прокси
- [x] `test/cli.test.js` — CLI: помощь, версия, инструменты, конфиг, ошибки
- [x] `src/cli/doctor.js` — команда `doctor`: Node, домашний каталог, конфиг, ключ, порт, сервисы
- [x] `src/cli/parser.js` — неизвестная команда даёт ошибку, а не запускает сервер по умолчанию
- [x] `npm test` — 389 тестов: 388 проходят, 1 пропущен, 0 падений

### step-19 — README и релиз-чеклист
- [x] `README.md` — установка, команды, конфиг, протокол `ai-serve`, MCP, примеры
- [x] `package.json` — версия `0.3.0`, репозиторий `u2re-space/u2ai-server`, зависимостей нет
- [x] Убраны пустые файлы-заготовки: `src/cli/renderer.js`, `src/roles/suggestor.js`
- [x] Роль `suggester` в enum'ах и дефолтах конфига (было `suggestor`)
- [x] `planned.md` — отметки шагов
- [x] Чеклист релиза: `npm run check` (78 файлов), `npm test` (389 тестов: 388 проходят, 1 пропущен),
      `npm pack --dry-run` (69 файлов, 143.8 КиБ), версия `0.3.0`, репозиторий настроен

### step-20 — Транспорты stdio в отдельных модулях
- [x] `src/server/stdio.js` — stdio-транспорт MCP-сервера: строка JSON на вход, строка JSON на выход
- [x] `src/client/stdio.js` — stdio-транспорт MCP-клиента: запуск внешнего сервера как дочернего процесса
- [x] `src/client/node.js` — удалён, код переехал в `src/client/stdio.js`
- [x] `src/server/mcp.js` — `startStdioServer` ушла в `src/server/stdio.js`, `errorResponse` стала экспортом
- [x] `src/index.js` — публичные экспорты не изменились: `startStdioServer`, `startNodeServer`
- [x] `test/stdio.test.js` — 9 тестов: обе стороны транспорта, битая строка, уведомление, смерть ребёнка, CLI `mcp`
- [x] `npm test` — 398 тестов: 397 проходят, 1 пропущен, 0 падений

---

## 2. Поздние этапы (вне v0.3)

| Этап | Содержание | Файлы-заготовки |
|---|---|---|
| step-late-1 — Удалённый доступ | `ai-serve` слушает не только `127.0.0.1`: аутентификация, TLS, ACL по рабочему каталогу | `src/agent/remote.js`, `src/tools/transfer.js` |
| step-late-2 — SSH и передача данных | `sshPlan` из монолита, копирование файлов между узлами, потоковая передача | `src/tools/transfer.js`, `src/agent/remote.js` |
| step-late-3 — Поддержка в других `submodules` | Точка входа в `@u2ai/decomposer`, `@u2ai/images`, `@u2ai/measurer`: переопределение доступа к FS, удалённое исполнение команд, transfer | общие модули `src/client/*` |
| step-late-4 — Безопасность и разграничения | Профили доступа, журнал действий, режим «только чтение», подтверждения на стороне сервера | `src/agent/access.js` |

---

## 3. Правила работы

1. Каждый шаг — отдельный коммит с сообщением `step-N: <что сделано>`; в этом же коммите
   галочки соответствующего шага в `planned.md` отмечаются.
2. Пуш не делаем: remote настроен, но репозиторий остаётся локальным.
3. Тексты CLI и README — на английском; сообщения валидации конфига — на русском
   (как в `u2ai-decomposer`, `u2ai-images`, `u2ai-measurer`).
4. Файлы, портированные из монолита, помечаются тегом `@ai.hint legacy-0.2`.
5. Протокол `ai-serve` — обратно совместимый с текущим `ai serve`: те же кадры, тот же
   `serve.json`, тот же порт и токен. Расширение VSCode не правится без необходимости.
6. MCP-сервер — приоритет v0.3: он появляется раньше шины и не зависит от неё.
7. Безопасность: `serve.json` в режиме `0600`, токен генерируется сервером, доступ
   к FS ограничен корнем задачи, запись и терминал требуют подтверждения.
8. Удалённый доступ, SSH и transfer не попадают в v0.3 — это поздние этапы выше.
