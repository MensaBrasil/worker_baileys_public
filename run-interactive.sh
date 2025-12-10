#!/usr/bin/env bash

set -euo pipefail

echo "Selecione o modo de execução:"
echo " 1) Todos os modos (default: add + remove + moderation + auth)"
echo " 2) Adição + auth (--add --auth)"
echo " 3) Remoção + auth (--remove --auth)"
echo " 4) Moderação + auth (--moderation --auth)"
echo " 5) Adição + remoção + auth (--add --remove --auth)"
echo " 6) Adição + moderação + auth (--add --moderation --auth)"
echo " 7) Remoção + moderação + auth (--remove --moderation --auth)"
echo " 8) Custom (digite as flags; --auth será adicionado automaticamente)"
printf "Opção: "
read -r choice

MODE_FLAGS=()

case "$choice" in
  1|"") MODE_FLAGS=() ;; # vazio ativa todos (default)
  2) MODE_FLAGS=(--add --auth) ;;
  3) MODE_FLAGS=(--remove --auth) ;;
  4) MODE_FLAGS=(--moderation --auth) ;;
  5) MODE_FLAGS=(--add --remove --auth) ;;
  6) MODE_FLAGS=(--add --moderation --auth) ;;
  7) MODE_FLAGS=(--remove --moderation --auth) ;;
  8)
    echo "Digite as flags (ex: --add --remove): "
    read -r custom_flags
    # shellcheck disable=SC2206
    MODE_FLAGS=($custom_flags --auth)
    ;;
  *) echo "Opção inválida."; exit 1 ;;
esac

echo
echo "Selecione o método de autenticação:"
echo " 1) QR code (default)"
echo " 2) Pairing code (--pairing, requer PAIRING_PHONE na .env)"
printf "Opção: "
read -r auth_choice

AUTH_FLAGS=()
case "$auth_choice" in
  1|"") AUTH_FLAGS=() ;;
  2) AUTH_FLAGS=(--pairing) ;;
  *) echo "Opção inválida."; exit 1 ;;
esac

FLAGS=("${MODE_FLAGS[@]}" "${AUTH_FLAGS[@]}")

echo "Iniciando loop com: pnpm start ${FLAGS[*]}"

while true; do
  git pull --rebase --autostash || echo "git pull falhou, tentando novamente na próxima iteração."

  if ! pnpm build; then
    echo "pnpm build falhou. Aguardando 10 segundos antes de tentar novamente..."
    sleep 10
    continue
  fi

  pnpm start "${FLAGS[@]}"

  echo "App fechado. Reiniciando em 10 segundos..."
  sleep 10
done
