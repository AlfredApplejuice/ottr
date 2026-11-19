# Podman injects the host's proxy env (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) into every
# container it starts. That NO_PROXY names the host's own targets, not the compose
# services, so internal calls (http://alate:4570, http://worker-a:8787,
# http://vm-runner:8787, http://ottr:<port>) would be routed to the corporate proxy,
# which sees the worker token on the board's vm-runner calls. Compose interpolation
# cannot see the injected value; the entry
# script can, so it appends the service names at container start, keeping the
# injected host list. POSIX sh, written to be sourced; safe under `set -e`; idempotent.
merge_no_proxy() {
	merged="$1"
	shift
	for name in "$@"; do
		case ",$merged," in
		*",$name,"*) ;;
		*) merged="${merged:+$merged,}$name" ;;
		esac
	done
	printf '%s' "$merged"
}
url_hosts() {
	[ -n "$1" ] || return 0
	printf '%s\n' "$1" | tr ',' '\n' | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|[:/].*||'
}
_ottr_no_proxy="${NO_PROXY:-${no_proxy:-}}"
NO_PROXY="$(merge_no_proxy "$_ottr_no_proxy" localhost 127.0.0.1 alate server ottr ottr-server worker-a worker-b $(url_hosts "${OTTR_WORKER_URLS:-}") $(url_hosts "${OTTR_VM_RUNNER_URL:-}"))"
no_proxy="$NO_PROXY"
export NO_PROXY no_proxy
unset -f merge_no_proxy url_hosts
unset _ottr_no_proxy
