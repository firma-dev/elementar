# Эшелон 0 — правила WAF зоны (§9.1)

Настраиваются в дашборде Cloudflare, здесь фиксируются как исходник. Это единственная
защита, которая ничего не стоит при атаке: срабатывает до Worker'а и не тарифицируется.

Действие везде — `managed_challenge`, **не** `block`: за одним IPv4 /24 у мобильного
оператора стоят десятки тысяч человек (§9.8, CGNAT).

```
(http.host eq "s.elementar.example" and http.request.uri.path matches "^/v1/docs/[^/]+$")
  → rate limit: 600 req / 1 min / ip, action: managed_challenge

(http.host eq "s.elementar.example" and http.request.method eq "POST" and http.request.uri.path eq "/v1/docs")
  → rate limit: 30 req / 1 hour / ip, action: managed_challenge

(http.host eq "s.elementar.example" and http.request.uri.path matches "^/v1/invite/")
  → rate limit: 20 req / 1 min / ip, action: block 60s

(cf.threat_score > 40 and starts_with(http.request.uri.path, "/v1/llm"))
  → managed_challenge
```

Хост — ЗАГЛУШКА `s.elementar.example`: домен ещё не выбран, значение синхронно
с `packages/proto/src/env.ts` (§1.3).

Дополнительно в зоне:

- Logpush **выключен** — путь содержит docId (§4.7.2 п.6).
- Кэширование ответов API запрещено (`Cache-Control: no-store` ставит Worker).
