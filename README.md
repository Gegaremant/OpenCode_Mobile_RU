# OpenCode Mobile (Русская локализация)

**Open-source Android-клиент для [opencode](https://github.com/sst/opencode) AI coding agent.**
AI-помощник для программирования с телефона — Android, через Google Play, F-Droid или APK.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Download APK](https://img.shields.io/badge/Download-APK-green?logo=android)](https://github.com/Gegaremant/OpenCode_Mobile_RU/releases/latest)

> **Не является официальным продуктом opencode.** OpenCode Mobile — независимый, созданный сообществом клиент, который не разработан, не одобрен и не связан с opencode / Anomaly. Приложение подключается к серверу opencode, который вы запускаете самостоятельно, используя открытый HTTP API opencode.

---

## Установка (Android)

1. **Прямая установка APK** — скачайте последний релиз и установите вручную:
   **https://github.com/Gegaremant/OpenCode_Mobile_RU/releases/latest**

2. **Оригинальные каналы установки** (без русской локализации):
   - **Google Play** — [play.google.com/store/apps/details?id=cc.agentlabs.opencode](https://play.google.com/store/apps/details?id=cc.agentlabs.opencode)
   - **F-Droid** — добавьте репозиторий `https://dzianisv.github.io/opencode-mobile/fdroid/repo` в клиент F-Droid

---

OpenCode Mobile — приложение на React Native / Expo, которое переносит возможности [opencode](https://github.com/sst/opencode) AI coding agent на ваш телефон. Подключайтесь к собственному серверу opencode через локальную сеть, Cloudflare Tunnel, ngrok или Tailscale — и пишите, просматривайте и отправляйте код из любой точки. Мобильный клиент **бесплатный и open-source** под лицензией MIT. Нет ограничений функций, нет телеметрии, которую вы не включали, и нет рекламы.

---

## Возможности

- **Офлайн демо-режим** — нажмите «Попробовать демо», чтобы увидеть полный пример исправления бага (рассуждение → grep → diff → запрос разрешения) без настройки
- **Множество подключений** — управление несколькими серверами opencode (локальная сеть, Cloudflare Tunnel, ngrok, Tailscale)
- **Биометрическая блокировка** — Face ID, Touch ID или отпечаток пальца для защиты приложения и отдельных отправок сообщений
- **Стриминговый чат** — посимвольная трансляция ответов с вашего сервера opencode
- **Просмотр diff** — наглядное отображение изменений в файлах
- **Подтверждение вызовов инструментов** — просмотр и одобрение (или отклонение) вызовов инструментов перед выполнением
- **Безопасное хранение учётных данных** — учётные данные сервера хранятся в Android Keystore через `expo-secure-store`
- **Управление сессиями** — просмотр, создание и возобновление сессий программирования

---

## Быстрый старт

**Ещё нет сервера?** Установите приложение и нажмите **«Попробовать демо»** на экране сессий — настройка не требуется.

**Шаг 1 — Запустите opencode на вашем компьютере**

```bash
# Установите opencode (если ещё не установлены)
npm install -g opencode-ai

# Запустите opencode в режиме сервера
OPENCODE_SERVER_PASSWORD=вашпароль opencode serve --hostname 0.0.0.0 --port 4096
```

**Шаг 2 — Установите OpenCode Mobile** через [прямой APK](#установка-android).

**Шаг 3 — Добавьте подключение в приложении**

Откройте приложение, нажмите **«Добавить подключение»** и выберите тип:

- **Локальная сеть** — LAN IP вашего компьютера, например `http://192.168.1.100:4096`
- **Туннель** — URL Cloudflare Tunnel или ngrok, например `https://my-opencode.trycloudflare.com`
- **Tailscale** — Tailscale IP вашего компьютера, например `http://100.x.x.x:4096`

Введите пароль, заданный на шаге 1, нажмите **«Подключить»** — и вы в деле.

---

## Как это работает

OpenCode Mobile — тонкий клиент. Он использует HTTP + SSE API opencode: список сессий, отправка сообщений, трансляция ответов и подписка на события изменения файлов. Все вызовы AI-моделей обрабатываются вашим сервером opencode — вы используете собственные API-ключи (OpenAI, Anthropic и т.д.), и приложение никогда их не касается. Приложение никогда не проксирует ваш код или разговор через наши серверы.

```
┌─────────────────────────────────────┐
│         OpenCode Mobile             │
│  (React Native / Expo)              │
└──────────────┬──────────────────────┘
               │  HTTP + SSE
               │  (локальная сеть / туннель)
               ▼
┌─────────────────────────────────────┐
│       Сервер opencode               │
│  (github.com/sst/opencode, MIT)     │
│  Запущен на вашем ПК / VPS          │
└──────────────┬──────────────────────┘
               │  Вызовы API
               ▼
┌─────────────────────────────────────┐
│   Ваш AI-провайдер                  │
│  (OpenAI / Anthropic / Gemini / …)  │
│  Ваши ключи, ваш счёт               │
└─────────────────────────────────────┘
```

---

## Статус проекта

| Возможность | Статус |
|---|---|
| Офлайн демо-режим | Стабильно |
| Множество подключений | Стабильно |
| Управление сессиями | Стабильно |
| Стриминговый чат | Стабильно |
| Просмотр diff | Стабильно |
| Биометрическая блокировка | Стабильно |
| Подтверждение вызовов инструментов | Стабильно |
| Русская локализация | Стабильно |

---

## Благодарности и спонсоры

Оригинальный проект создан и поддерживается [VIBE TECHNOLOGIES, LLC](https://agentlabs.cc/opencode). Если OpenCode Mobile экономит ваше время, рассмотрите поддержку:

**[github.com/sponsors/VibeTechnologies](https://github.com/sponsors/VibeTechnologies)**

---

## Roadmap

Отслеживается на [GitHub Projects](https://github.com/dzianisv/opencode-mobile/projects) и в [open milestones](https://github.com/dzianisv/opencode-mobile/milestones).

Ближайшие приоритеты:
- opencode Cloud (одно нажатие для подключения)
- F-Droid mainline (FCM audit + воспроизводимая сборка)
- Мастер настройки туннелей (Cloudflare / ngrok / Tailscale)
- iPad / планшетный интерфейс
- Кэш офлайн-истории сессий

---

## Участие в разработке

Мы приветствуем отчёты об ошибках, запросы функций и pull request'ы. Смотрите [CONTRIBUTING.md](https://github.com/dzianisv/opencode-mobile/blob/main/CONTRIBUTING.md) для настройки среды разработки.

---

## Конфиденциальность

OpenCode Mobile не собирает личные данные. Опциональный Sentry (отключён по умолчанию) отправляет анонимные трассировки ошибок. SDK аналитики не включены. Учётные данные хранятся исключительно на устройстве в системном хранилище.

---

## Лицензия

MIT License — см. [LICENSE](LICENSE).

---

*Это неофициальная русская сборка оригинального проекта [dzianisv/opencode-mobile](https://github.com/dzianisv/opencode-mobile).*
