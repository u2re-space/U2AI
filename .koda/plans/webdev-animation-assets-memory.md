# Анимация, две стадии картинок, внешняя память и скилл поиска

Цель: в системе генерации `@u2ai/webdev` (`submodules/u2ai-webdev`) появились
специализированная стадия `animation` с ролью `animator`, вторая суб-стадия картинок
после редактора, внешняя программа `ai-memory` в руках ролей и скилл `file-search`
для поиска файлов. Правки стилей после стадии `styling` уходят на младшую модель.

Решения пользователя: две стадии картинок (до и после `vector`); `animation` — после
`styling`, до `coding`; `ai-memory` — MCP, а если сервера нет, то CLI.

## План

1. [x] **Стадия `animation` и роль `animator`**
   - Навыки: koda-coder, modern-web-guidance
   - Файлы:
     - src/roles/animator.js (роль, ремесло движения)
     - src/roles/chunks.js (часть `motion` у ворот записи)
     - src/roles/index.js (регистрация роли)
     - src/stages/animation.js (стадия по шагам плана роли)
     - src/stages/index.js (реестр стадий)
     - src/stages/roles.js (LIVE_ROLES)
     - src/stages/plan-order.js (пол: анимация после стилей)
     - src/stages/step.js, src/roles/index.js (роль → стадия)
     - src/stages/review.js, src/pipeline.js, src/agent/pace.js (карты роли и стадии)
     - src/config/constants.js, src/config/defaults.js (стадия, роль, усилие, модель дома)
     - src/agent/schemas.js, src/cli/input.js (схема плана, метка стадии)
   - Проверка: `npm test` — тесты ролей, стадий и прогона.

2. [x] **Правки стилей после стадии `styling` — на младшей модели**
   - Навыки: koda-coder
   - Файлы:
     - src/roles/index.js (начальная фаза роли)
     - src/stages/sight.js (починка стилей — фаза `polish`)
     - src/stages/review.js (ремонт стилей — фаза `polish`)
     - test/ranks.test.js, test/sight.test.js (старое решение заменено новым)
   - Проверка: тест лестницы рангов и тест взгляда на страницу.

3. [x] **Стадия картинок: две суб-стадии, вторая — после `vector`**
   - Навыки: koda-coder
   - Файлы:
     - src/roles/illustrator.js (роль, которая раскладывает ассеты по местам)
     - src/stages/assets.js (новая стадия после `vector`)
     - src/stages/index.js, src/stages/roles.js, src/stages/plan-order.js
     - src/stages/review.js, src/pipeline.js, src/agent/pace.js
     - src/config/constants.js, src/config/defaults.js
     - src/inputs/index.js (готовые картинки в контексте ролей)
   - Проверка: тесты стадий и прогона.

4. [x] **`ai-memory` — внешняя программа в руках ролей**
   - Навыки: koda-coder
   - Файлы:
     - src/agent/tool-specs.js (инструмент `call_ai_memory`)
     - src/agent/tools.js (вызов: MCP, а если нет — CLI)
     - src/roles/memory-note.js (правило для ролей)
     - src/roles/*.js (инструмент в списках ролей)
     - src/config/defaults.js, src/config/validate.js (программа памяти)
   - Проверка: `test/tools.test.js` — инструмент зовёт программу.

5. [x] **Скилл `file-search` и доработка поиска файлов**
   - Навыки: file-search, koda-coder
   - Файлы:
     - skills/file-search/ (вендор пака: SKILL.md, references, лицензии, NOTICE)
     - src/agent/skills.js (чтение файла пака)
     - src/agent/tool-specs.js, src/agent/tools.js (`read_skill` с файлом)
     - src/agent/fs-tools.js (контекст строк, исключения, регистр, порядок)
   - Проверка: `test/skills.test.js`, `test/tools.test.js`.

6. [x] **Документация и общие проверки**
   - Навыки: koda-coder
   - Файлы:
     - README.md (EN) — таблицы стадий и ролей, модели дома, мост памяти, скиллы
     - planned.md (RU) — step-113
   - Проверка: `npm test`, `npm run check`, `git diff --check`.

Критерии приёмки: новая стадия `animation` идёт между стилями и кодом и берёт свои шаги
плана; правки стилей после `styling` считаются на `openai/gpt-6.1-terra`; стадия картинок
делится на подготовку (до `vector`) и раскладку (после `vector`); роль зовёт `ai-memory`
через MCP или через CLI; скилл `file-search` виден ролям и его ссылки читаются; все тесты
пакета проходят.
