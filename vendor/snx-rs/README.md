# snx-rs binaries (AGPL-3.0)

Сюда кладёт `npm run fetch:snx` / `scripts/fetch-snx-rs.sh` upstream-бинари
[`ancwrd1/snx-rs`](https://github.com/ancwrd1/snx-rs).

При сборке electron-builder копирует каталог в `Resources/snx-rs`.
Если каталог пуст — Kontur ищет `snxctl`/`snx-rs` в PATH (Homebrew).

Не коммитьте бинарники без необходимости; в CI/релизе гоняйте `fetch:snx` перед `dist`.
