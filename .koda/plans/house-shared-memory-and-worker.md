# План: интерфейсы и механизмы `u2ai-subagent` в `u2ai-images`, `u2ai-webdev`, `u2ai-subagent`

## Цель

Перенести в три системы дома (`u2ai-images`, `u2ai-webdev`, `u2ai-subagent`) один и тот же набор
механизмов:

1. **Worker mode** — воркер, который выполняет цикл модели и просит родителя выполнить
   инструменты (как в `u2ai-subagent`).
2. **Shared memory / SharedArrayBuffer** — общая память между родителем и потоком, без копий.
3. **Передача байтов / base64 напрямую** — без файловой системы.
4. **Tmp-кэш / ramdisk** — backend доступа в памяти + байтовый кэш на `SharedArrayBuffer`.
5. **magick-wasm** — полноценный растровый движок, а не только сверка в `ai-webdev`.
6. **Allocate 1/2/4/8 GB RAM** — большие буферы.

## Решения (согласованы с пользователем)

| Вопрос | Решение |
|---|---|
| Где живут общие механизмы | **Дублировать в каждый пакет** (как `house.js` / `child-log.js` уже сделано) |
| Worker mode у images | **Полноценный subagent-style worker** (цикл модели + вызов инструментов родителем) |
| Глубина magick-wasm | **Полный растровый движок + общий backend** (webdev переиспользует его) |
| Форма ramdisk | **Access backend + байтовый кэш** |

## Проверенные факты (эксперименты)

- `SharedArrayBuffer` **не пересекает границу процесса** в Node IPC (`#<SharedArrayBuffer>
  could not be cloned`) — только потоки. `u2ai-subagent` это уже учитывает.
- `Buffer` из пула Node **нельзя передать** через `postMessage` с transfer-list
  (`DataCloneError`); нужен `Uint8Array.from(...)` со своим `ArrayBuffer`.
- `SharedArrayBuffer` на 8 GB выделяется мгновенно (виртуальная память, resident pages не трогаются).
- magick-wasm грузится: **ImageMagick 7.1.2-35 Q8 wasm64**, форматы AVIF/BMP/GIF/JPEG/PNG/SVG/TIFF/WEBP.
  Работают: `trim`, `crop`, `extent`, `resize`, `histogram` (точное число цветов), `sharpen`,
  `composite`, `separate`, `blur`, `quantize`, `compare`.
  **Сломаны** в обёртке: `uniqueColors()` (ошибка `n is not a function`), `backgroundColor` (нужен
  `MagickColor`, а не строка). RGBA-доступ — только через `getPixels().toByteArray(..., 'RGBA')`.
- `u2ai-images`: `src/client/*` (5 файлов) и `src/server/*` (2 файла) — пустые заглушки.
- `u2ai-images`: нет `exports`-карты в package.json, нет `.d.ts`, типы только в JSDoc.

## Шаги

- [x] **1. Общий модуль общей памяти и байтовых каналов — `src/shared/shared.js`**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/shared/shared.js` (новый)
    - `submodules/u2ai-webdev/src/shared/shared.js` (новый)
    - `submodules/u2ai-subagent/src/shared/shared.js` (расширить)
  - Содержимое: `SHARED_MAGIC`, `SHARED_VERSION`, `SHARED_REGIONS`, `FLAG_CANCEL`,
    `sharedAvailable()`, `createSharedBlock()`, `readSharedBlock()` — **байт-в-байт как в
    `u2ai-subagent`**, чтобы три системы говорили об одном.
  - Проверка: тест `createSharedBlock` → `readSharedBlock` round-trip в каждом пакете.
  - **Готово**: три файла идентичны (MD5 `2CFACB19...`), тесты subagent — 31/31 зелёные.

- [x] **2. Протокол кадров с байтами и base64 — `src/shared/protocol.js`**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/shared/protocol.js` (новый)
    - `submodules/u2ai-webdev/src/shared/protocol.js` (новый)
    - `submodules/u2ai-subagent/src/shared/protocol.js` (новый)
    - `submodules/u2ai-subagent/src/client/protocol.js` (теперь ре-экспорт)
  - Содержимое: `PROTOCOL_VERSION`, `FRAME` (`spawn`, `ready`, `status`, `call`, `result`,
    `report`, `error`, `stop`, **`bytes`**, **`base64`**), `createFrame()`, `isFrame()`,
    `bytesFrame()`, `base64Frame()`, `bytesOfFrame()`, `bytesOf()`, `base64Of()`.
  - Проверка: тест `isFrame` отбрасывает чужую версию и неизвестный вид.
  - **Готово**: три файла идентичны; `client/protocol.js` в subagent переведён на ре-экспорт.

- [x] **3. Общий runtime воркера — `src/shared/worker.js`**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/shared/worker.js` (новый)
    - `submodules/u2ai-webdev/src/shared/worker.js` (новый)
    - `submodules/u2ai-subagent/src/shared/worker.js` (новый)
    - `submodules/u2ai-subagent/src/client/interface.js` — правка транспорта `process`
    - `submodules/u2ai-subagent/src/server/interface.js` — правка `connected`
  - Содержимое: `workerEntry()`, `channelOf()`, `startWorker()`, `runWorker()`, `workerMain()`,
    `spawnWorker()`, `runWorkerCycle()`. Транспорт `thread` несёт `SharedArrayBuffer` и
    переносит буферы; транспорт `process` получает спеку первым кадром `spawn` и несёт
    байты как base64.
  - **Готово**: исправлены два бага процесса — `spawn` не отправлялся, а `channelOf`
    отбрасывал кадры из-за проверки `!raw.connected` (у `process` этого поля нет).
    Добавлен тест «sub-agent runs in a process» — 31/31 зелёные.

- [x] **4. Ramdisk: backend доступа в памяти + байтовый кэш — `src/access/ramdisk.js`**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/access/ramdisk.js` (новый)
    - `submodules/u2ai-webdev/src/access/ramdisk.js` (новый)
    - `submodules/u2ai-subagent/src/access/ramdisk.js` (новый)
  - Содержимое: `createRamdiskFileSystem()` (тот же контракт, что `access/native.js`:
    `readFile`, `writeFile`, `readdir`, `stat`, `lstat`, `realpath`, `unlink`, `mkdir`,
    `rename`, `copy`), `createRamdisk({ capacityBytes })` — общий кэш байтов на
    `SharedArrayBuffer` с общей памятью, `allocateMemory({ bytes })` — блок на 1/2/4/8 GB.
  - Проверка: тест «файл записан в ramdisk, прочитан другим backend'ом, тот же объект памяти».
  - **Готово**: три файла идентичны; 8 тестов зелёные, включая allocate 8 GB.

- [x] **5. Байтовый канал: передача без файловой системы**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/shared/protocol.js` — `bytesFrame`, `base64Frame`,
      `bytesOfFrame`, `bytesOf`, `base64Bytes`, `base64Of`
    - `submodules/u2ai-images/src/shared/worker.js` — `postBytes` в канале
    - `submodules/u2ai-subagent/src/agent/core.js` — `onBytes` в цикле
    - `submodules/u2ai-subagent/src/server/interface.js` — `onBytes` в воркере
  - **Готово**: `bytesOf`/`base64Of`/`bytesFrame` живут в `shared/protocol.js` — отдельный
    модуль `shared/bytes.js` не понадобился. Байты идут кадром `bytes` (с переносом буфера)
    или `base64` (для процесса). Ошибка найдена и исправлена: `bytesOf` кодировал строку
    base64 вместо декодирования.

- [x] **6. Worker mode `u2ai-images` — цикл модели в воркере**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/agent/worker.js` (новый) — цикл: модель → `call` → родитель → `result`
    - `submodules/u2ai-images/src/agent/worker-runner.js` (новый) — `runImageWorker`, `spawnImageWorker`
    - `submodules/u2ai-images/bin/ai-image-agent-worker.js` (новый) — вход воркера
    - `submodules/u2ai-images/src/index.js` — экспорт нового API
    - `submodules/u2ai-images/package.json` — `exports`-карта, новый `bin`
  - **Готово**: 6 тестов зелёные; воркер создаёт свой клиент из спеки, читает инструкции
    из общей памяти, останавливается по флагу отмены.

- [x] **7. Worker mode `u2ai-webdev` — тот же контракт**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-webdev/src/agent/worker.js` (новый)
    - `submodules/u2ai-webdev/src/agent/worker-runner.js` (новый)
    - `submodules/u2ai-webdev/bin/ai-webdev-agent-worker.js` (новый)
    - `submodules/u2ai-webdev/src/index.js` — экспорт
    - `submodules/u2ai-webdev/package.json` — новый `bin`
  - **Готено**: 6 тестов зелёные; 903 теста пакета — зелёные.

- [x] **8. magick-wasm как полноценный растровый движок**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/image/magick-wasm.js` (новый) — загрузка wasm, `decodeRgba`,
      `encodeRgba`, `resize`, `trim`, `paletteStats`, `colorCount`, `compare`
    - `submodules/u2ai-images/src/image/raster.js` — цепочка `sharp → canvas → magick → magick-wasm`
    - `submodules/u2ai-images/src/config/constants.js` — `rasterEngines` += `wasm`
    - `submodules/u2ai-images/src/help.js` — `--engine` += `wasm`
    - `submodules/u2ai-images/package.json` — `optionalDependencies: @imagemagick/magick-wasm`
    - `submodules/u2ai-webdev/src/agent/magick-wasm.js` (новый) — тот же модуль
    - `submodules/u2ai-webdev/src/agent/image-magick.js` — свой загрузчик заменён на общий
  - **Готово**: 8 тестов зелёные. Три факта о wasm, найденные экспериментом и заложенные
    в адаптер:
    - пиксели читаются форматом `Rgba` **последним** действием и **внутри** колбэка
      (картинка освобождается при выходе из колбэка);
    - кадр входит в wasm как `MagickReadSettings{width, height, format: Rgba}`;
    - PNG пишется как **`Png32`**: обычный `Png` пишет палитру в 1 бит и теряет цвета.
    `getPixels()` и `uniqueColors()` в обёртке сломаны и не используются.

- [x] **9. Конфиг: лимиты памяти и tmp**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/src/config/defaults.js` — `memory: { cacheBytes, allocateBytes, inMemory }`
    - `submodules/u2ai-images/src/config/validate.js` — проверка новых полей
    - `submodules/u2ai-images/src/config/env.js` — `AI_IMAGE_CACHE_BYTES`, `AI_IMAGE_ALLOCATE_BYTES`
    - `submodules/u2ai-images/src/config/constants.js` — `GiB`
  - **Готово**: валидатор принимает `allocateBytes` до 8 GB и отклоняет больше.

- [x] **10. Документация**
  - Навыки: `koda-coder`
  - Файлы:
    - `submodules/u2ai-images/README.md` — разделы про worker, shared memory, bytes, ramdisk, wasm
    - `submodules/u2ai-webdev/README.md` — раздел «The worker of the house»
    - `submodules/u2ai-subagent/README.md` — разделы про bytes и ramdisk, таблица пакета
  - **Готово**: `exports`-карты добавлены в `package.json` всех трёх пакетов
    (`./shared`, `./protocol`, `./worker`, `./ramdisk`), новые `bin` — `ai-image-agent-worker`
    и `ai-webdev-agent-worker`.

## Итог

| Пакет | Тесты | Синтаксис |
|---|---|---|
| `u2ai-images` | 275 pass / 0 fail (276 всего, 1 skip — сетевой) | 148/148 |
| `u2ai-subagent` | 31 pass / 0 fail | 53/53 |
| `u2ai-webdev` | 903 pass / 0 fail | 255/255 |

### Что сделано

1. **Общая память** (`src/shared/shared.js`) — байт-в-байт одинакова в трёх пакетах.
2. **Протокол с байтами** (`src/shared/protocol.js`) — кадры `bytes` и `base64`.
3. **Runtime воркера** (`src/shared/worker.js`) — транспорты `thread`/`process`, канал, цикл.
4. **Ramdisk** (`src/access/ramdisk.js`) — файловая система в памяти, кэш на `SharedArrayBuffer`,
   `allocateMemory` на 1/2/4/8 GB.
5. **Worker mode** — `u2ai-images` (`runImageWorker`) и `u2ai-webdev` (`runWebWorker`).
6. **magick-wasm** — полноценный растровый движок (`sharp → canvas → magick → wasm`),
   точный подсчёт цветов, `trim`/`resize`/`compare`.
7. **Конфиг памяти** — `memory.cacheBytes`, `memory.allocateBytes`, `memory.inMemory`.

### Баги, найденные и исправленные попутно

- **Транспорт `process` в `u2ai-subagent` висел вечно**: кадр `spawn` не отправлялся, и
  `channelOf` отбрасывал кадры из-за проверки `!raw.connected` (у `process` такого поля нет).
  Два независимых бага — оба исправлены, добавлен тест.
- **`bytesOf` кодировал base64-строку вместо декодирования** — найдено тестом.
- **`getPixels()` и `uniqueColors()` в обёртке magick-wasm сломаны** (`n is not a function`) —
  обойдены через raw-форматы.
- **PNG в magick-wasm пишется палитрой в 1 бит** — обойдено через `Png32`.
- **`wasmDecode`/`wasmEncode` в u2ai-images** не существовали — реализованы.

## Порядок и зависимости

```
1 (shared.js)  →  2 (protocol.js)  →  3 (ramdisk)  →  4 (bytes)
                                    ↓
                     5 (images worker)  →  6 (webdev worker)
                                    ↓
                     7 (magick-wasm)  →  8 (config)  →  9 (tests+docs)
```

## Шаг 11: `u2ai-server`

- [x] **11.1. Общие модули дома в `src/shared/house/`**
  - Файлы:
    - `submodules/u2ai-server/src/shared/house/shared.js` (новый)
    - `submodules/u2ai-server/src/shared/house/protocol.js` (новый)
    - `submodules/u2ai-server/src/shared/house/worker.js` (новый)
    - `submodules/u2ai-server/src/access/ramdisk.js` (новый)
  - **Имя-коллизия**: `src/shared/protocol.js` в сервере — это протокол шины `ai-serve`
    (`PROTOCOL_VERSION '0.4'`, `FRAME_TYPES`, лимиты кадра). Он остался на месте; общие
    модули дома легли в подпапку `src/shared/house/`. Ничего существующего не переехало.
  - Проверка: три файла идентичны пакетам `u2ai-images`/`u2ai-webdev`/`u2ai-subagent`
    (MD5 совпадает).

- [x] **11.2. Worker mode сервера**
  - Файлы:
    - `submodules/u2ai-server/src/agent/worker.js` (новый) — цикл модели
    - `submodules/u2ai-server/src/agent/worker-runner.js` (новый) — `runServerWorker`
    - `submodules/u2ai-server/bin/ai-serve-agent-worker.js` (новый)
    - `submodules/u2ai-server/src/index.js` — экспорт
    - `submodules/u2ai-server/package.json` — `exports`-карта, новый `bin`

- [x] **11.3. Суб-агенты в CLI-агенте сервера**
  - Файлы:
    - `submodules/u2ai-server/src/agent/role-subagent.js` (новый) — спавнер,
      `ROLE_SUBAGENTS`, `roleSubagentNote`
    - `submodules/u2ai-server/src/roles/index.js` — роль получает инструмент `subagent`
      и правило hand-over; вызов `subagent` перехватывается в цикле
    - `submodules/u2ai-server/src/cli.js` — CLI создаёт спавнер
    - `submodules/u2ai-server/src/agent/subagent.js` — **исправление**: гейт записи
      закрыт (`output: { writeGate: false }`)

- [x] **11.4. Тесты и документация**
  - Файлы:
    - `submodules/u2ai-server/test/house-worker.test.js` (новый) — 11 тестов
    - `submodules/u2ai-server/test/role-subagent.test.js` (новый) — 6 тестов
    - `submodules/u2ai-server/README.md` — раздел «The worker of the house»
  - Проверка: `npm test` в сервере — 528 тестов, 527 проходят, 0 падений.

## Критерии успеха

- `npm test` — зелёные в `u2ai-images`, `u2ai-webdev`, `u2ai-subagent`, `u2ai-server`.
- `npm run check` (`node --check` по всем файлам) — без ошибок.
- Общая память реально общая: запись в `SharedArrayBuffer` родителя видна в потоке без копии.
- Байты передаются между родителем и воркером без записи на диск.
- magick-wasm работает как растровый движок, а не только как сверка.
- Буфер на 8 GB выделяется по запросу конфига.

## Итог (все четыре пакета)

| Пакет | Тесты | Синтаксис |
|---|---|---|
| `u2ai-images` | 275 pass / 0 fail | 148/148 |
| `u2ai-webdev` | 903 pass / 0 fail | 255/255 |
| `u2ai-subagent` | 31 pass / 0 fail | 53/53 |
| `u2ai-server` | 527 pass / 0 fail (528 всего, 1 skip) | 130/130 |

### Баги, найденные и исправленные попутно

- **Транспорт `process` в `u2ai-subagent` висел вечно**: кадр `spawn` не отправлялся, и
  `channelOf` отбрасывал кадры из-за проверки `!raw.connected` (у `process` такого поля нет).
  Два независимых бага — оба исправлены, добавлен тест.
- **Гейт записи блокировал суб-агента сервера**: `write_file` не доходил до родителя,
  потому что модель должна была сначала вызвать `write_ready` — инструмента, которого
  нет в наборе ролей сервера. Гейт закрыт (`output: { writeGate: false }`); два падающих
  теста сервера (доставшиеся от прежнего состояния) теперь зелёные.
- **`bytesOf` кодировал base64-строку вместо декодирования** — найдено тестом.
- **`getPixels()` и `uniqueColors()` в обёртке magick-wasm сломаны** (`n is not a function`) —
  обойдены через raw-форматы.
- **PNG в magick-wasm пишется палитрой в 1 бит** — обойдено через `Png32`.
