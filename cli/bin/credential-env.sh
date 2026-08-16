#!/usr/bin/env bash

# Seal model credentials into an inherited descriptor, then remove secrets from
# the environment that the OmniScientist process and its research subprocesses expose.

# Parse dotenv-style files as data. Never source a user-controlled credential
# file: command substitutions and shell statements would execute on the host
# before Docker has a chance to isolate anything.
omnisci_load_env_file() {
  local om_file="$1"
  local om_line om_name om_value om_first om_last
  local om_line_no=0
  [ -f "$om_file" ] || return 0

  while IFS= read -r om_line || [ -n "$om_line" ]; do
    om_line_no=$((om_line_no + 1))
    om_line="${om_line%$'\r'}"
    [[ "$om_line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$om_line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$om_line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      echo "OmniScientist env 文件格式错误: $om_file:$om_line_no（只允许 KEY=VALUE）" >&2
      return 65
    fi
    om_name="${BASH_REMATCH[2]}"
    om_value="${BASH_REMATCH[3]}"
    om_value="${om_value#"${om_value%%[![:space:]]*}"}"
    om_value="${om_value%"${om_value##*[![:space:]]}"}"

    if [ "${#om_value}" -ge 2 ]; then
      om_first="${om_value:0:1}"
      om_last="${om_value: -1}"
      if { [ "$om_first" = '"' ] && [ "$om_last" = '"' ]; } || \
         { [ "$om_first" = "'" ] && [ "$om_last" = "'" ]; }; then
        om_value="${om_value:1:${#om_value}-2}"
      elif [ "$om_first" = '"' ] || [ "$om_first" = "'" ] || \
           [ "$om_last" = '"' ] || [ "$om_last" = "'" ]; then
        echo "OmniScientist env 文件引号不配对: $om_file:$om_line_no" >&2
        return 65
      fi
    fi

    case "$om_name" in
      DEEPSEEK_API|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|OMNISCI_API_KEY|OPENAI_API_KEY|OMNISCI_VISION_PROVIDER|OMNISCI_VISION_MODEL|OMNISCI_VISION_BASE_URL|OMNISCI_VISION_EFFORT|OMNISCI_UPDATE_CHECK)
        printf -v "$om_name" '%s' "$om_value"
        export "$om_name"
        ;;
      *)
        # Shared key stores contain unrelated credentials. Ignore them instead
        # of importing secrets OmniScientist does not need.
        ;;
    esac
  done < "$om_file"
}

omnisci_seal_credentials() {
  if [ -n "${OMNISCI_CREDENTIAL_FD:-}" ]; then
    return
  fi

  local om_ds="${DEEPSEEK_API:-${DEEPSEEK_API_KEY:-}}"
  local om_anthropic="${ANTHROPIC_API_KEY:-}"
  local om_custom="${OMNISCI_API_KEY:-}"
  local om_openai="${OPENAI_API_KEY:-}"
  local om_value
  for om_value in "$om_ds" "$om_anthropic" "$om_custom" "$om_openai"; do
    if [[ "$om_value" == *$'\n'* ]]; then
      echo "OmniScientist API key 不能包含换行。" >&2
      return 65
    fi
  done

  # 行序即协议，parseCredentialPayload 按位取。只能往后追加。
  local om_fd
  exec {om_fd}<<<"${om_ds}"$'\n'"${om_anthropic}"$'\n'"${om_custom}"$'\n'"${om_openai}"

  local om_name
  while IFS= read -r om_name; do
    if [[ "$om_name" =~ (KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE) ]]; then
      unset "$om_name"
    fi
  done < <(compgen -e)
  unset DEEPSEEK_API DEEPSEEK_API_KEY ANTHROPIC_API_KEY OMNISCI_API_KEY OPENAI_API_KEY

  export OMNISCI_CREDENTIAL_FD="$om_fd"
}
