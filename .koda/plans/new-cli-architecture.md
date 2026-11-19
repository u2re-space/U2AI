# Новая архитектура CLI ai-webdev

## Согласованный scope

- `ai-webdev` — внешняя полноэкранная CLI-оболочка на `terminal-kit`.
- `ai-webdev-worker` — внутренний headless-процесс с классическим stdout/stderr и двунаправленным IPC-протоколом.
- Оболочка поддерживает весь текущий набор команд: `run`, `plan`, `sight`, `stages`, `component`, `install`, `config`, `jobs`, `memory`, `skills`.
- Машинный режим остаётся доступен явно (`--json`, `--quiet` или отдельный headless-флаг), чтобы CI и старые вызовы не попадали в TUI.
- IPC-протокол версионируется; stdout/stderr worker-а остаются классическими и одновременно показываются в панели логов оболочки.
- Оператор может передавать steering, отвечать на `ask_user`, пропускать стадию/шаг и завершать прогон.

## План

1. [x] **Выделить внутренний IPC-worker и общий протокол**
   - Навыки: `koda-coder`
   - Файлы:
     - `submodules/u2ai-webdev/src/cli/protocol.js`
     - `submodules/u2ai-webdev/src/cli/worker.js`
     - `submodules/u2ai-webdev/src/cli/input-state.js`
     - `submodules/u2ai-webdev/src/cli/input.js`
     - `submodules/u2ai-webdev/src/cli.js`
     - `submodules/u2ai-webdev/bin/ai-webdev-worker.js`
     - `submodules/u2ai-webdev/test/worker.test.js`
   - Проверка: worker запускается как дочерний процесс, принимает команды и вопросы по IPC, возвращает события и код завершения.

2. [x] **Собрать внешнюю terminal-kit-оболочку для всех команд**
   - Навыки: `koda-coder`
   - Файлы:
     - `submodules/u2ai-webdev/src/tui/worker-client.js`
     - `submodules/u2ai-webdev/src/tui/state.js`
     - `submodules/u2ai-webdev/src/tui/render.js`
     - `submodules/u2ai-webdev/src/tui/app.js`
     - `submodules/u2ai-webdev/src/tui/cli.js`
     - `submodules/u2ai-webdev/bin/ai-webdev.js`
     - `submodules/u2ai-webdev/test/tui.test.js`
   - Проверка: reducer и protocol покрыты тестами; TUI показывает состояние стадий, прогресс, live-логи и ввод оператора.

3. [x] **Подключить пакет, команды и документацию**
   - Навыки: `koda-coder`
   - Файлы:
     - `submodules/u2ai-webdev/package.json`
     - `submodules/u2ai-webdev/package-lock.json`
     - `submodules/u2ai-webdev/src/help.js`
     - `submodules/u2ai-webdev/README.md`
     - `submodules/u2ai-webdev/planned.md`
   - Проверка: `terminal-kit` установлен; help и README описывают TUI, worker и headless-режим.

4. [x] **Проверить совместимость и TUI**
   - Навыки: `koda-coder`
   - Проверки:
     - `npm test`
     - `npm run check`
     - `git diff --check`
     - ручной запуск TUI и IPC-сценариев на Windows.

## Результат проверки

- `submodules/u2ai-webdev`: `npm test` — 690/690; `npm run check` — 215/215; `git diff --check` — чисто.
- `test/webdev-bridge.test.js` в корне — 10/10.
- Полный `npm test` корня: 985 тестов прошли, 2 упали в несвязанных существующих местах (`test/browser.test.js`, `test/complete.test.js`).
- TUI запущен под псевдотерминалом (`script.exe`): процесс завершился с кодом 0 и вернул терминал в обычный режим.
