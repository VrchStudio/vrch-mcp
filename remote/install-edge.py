#!/usr/bin/env python3
"""Install one MCP ingress into an existing, locally managed SG or EA tunnel.

Run as root from the committed checkout on the host of the chosen environment.
SG is the default; EA requires --environment ea and the exact formal hostname.
Preserve all neighboring ingress and store only affected configuration for
rollback. Never read tunnel credentials. --dry-run validates and prints the
redacted change without writing configuration, routing DNS or reloading.
"""
import argparse
from datetime import datetime, timezone
import difflib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

# Each environment owns exactly its hostname; EA never accepts an SG name.
ENVIRONMENTS = {"sg": r"mcp-sg\.[a-z0-9.-]+", "ea": r"mcp\.vrch\.ai"}
MARKER = "  # __VRCH_CUSTOM_BINDINGS_END__"
UPSTREAM = "http://127.0.0.1:18917"


def parse(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=sorted(ENVIRONMENTS), default="sg")
    parser.add_argument("--host", required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--bindings", required=True, type=Path)
    parser.add_argument("--origincert", required=True)
    parser.add_argument("--unit", required=True)
    parser.add_argument("--cloudflared", default="/usr/local/bin/cloudflared")
    parser.add_argument("--dry-run", action="store_true")
    # Paths below are fixed in production; tests substitute temporary files.
    parser.add_argument("--nginx-conf", type=Path, default=Path("/etc/nginx/conf.d/vrch-mcp.conf"), help=argparse.SUPPRESS)
    parser.add_argument("--backup-root", type=Path, default=Path("/var/backups/vrch-mcp"), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not re.fullmatch(ENVIRONMENTS[args.environment], args.host):
        parser.error(f"Host {args.host} does not belong to the {args.environment.upper()} environment.")
    return parser, args


def plan(parser, args):
    original = args.config.read_text()
    match = re.search(r"^tunnel:\s*([a-f0-9-]+)\s*$", original, re.M)
    if not match or original.count(MARKER) != 1:
        parser.error("Expected an existing locally managed tunnel and custom-bindings marker.")
    route = f"  - hostname: {args.host}\n    service: {UPSTREAM}\n"
    if re.search(r"^\s*- hostname:\s*" + re.escape(args.host) + r"\s*$", original, re.M):
        if route not in original:
            parser.error("Existing MCP route differs; refusing replacement.")
        candidate = original
    else:
        candidate = original.replace(MARKER, route + MARKER)
    bindings = original_bindings = args.bindings.read_text()
    line = args.host + "\t" + UPSTREAM + "\n"
    if any(row.split("\t")[0] == args.host and row + "\n" != line for row in bindings.splitlines()):
        parser.error("Existing MCP binding differs; refusing replacement.")
    if line not in bindings:
        bindings = bindings.rstrip("\n") + "\n" + line
    rendered = Path(__file__).with_name("nginx.conf.template").read_text().replace("MCP_HOST", args.host)
    current_nginx = args.nginx_conf.read_text() if args.nginx_conf.exists() else None
    return {"tunnel": match[1], "original": original, "candidate": candidate,
            "original_bindings": original_bindings, "bindings": bindings,
            "rendered": rendered, "nginx_changed": current_nginx != rendered}


def run(command):
    subprocess.run(command, check=True)


def validate_ingress(args, candidate):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yml") as temp:
        temp.write(candidate)
        temp.flush()
        run([args.cloudflared, "tunnel", "--config", temp.name, "ingress", "validate"])


def show(args, value):
    print(f"Environment: {args.environment.upper()}  Host: {args.host}  Tunnel: {value['tunnel'][:8]}...")
    for name, before, after in ((args.config.name, value["original"], value["candidate"]),
                                (args.bindings.name, value["original_bindings"], value["bindings"])):
        added = [line[2:].strip() for line in difflib.ndiff(before.splitlines(), after.splitlines()) if line.startswith("+ ")]
        print(f"{name}: " + ("add " + "; ".join(added) if added else "unchanged"))
    print(f"{args.nginx_conf}: " + ("write rendered template" if value["nginx_changed"] else "unchanged"))
    print("DNS route: " + ("add " + args.host if value["candidate"] != value["original"] else "unchanged"))


def install(args, value):
    route_changed = value["candidate"] != value["original"]
    bindings_changed = value["bindings"] != value["original_bindings"]
    if not (route_changed or bindings_changed or value["nginx_changed"]):
        print(f"{args.environment.upper()} MCP ingress already installed; nothing changed.")
        return
    backup = args.backup_root / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup.mkdir(parents=True, mode=0o700)
    for file in (args.config, args.bindings, args.nginx_conf):
        if file.exists():
            shutil.copy2(file, backup / file.name)
    if route_changed:
        # A DNS route is an idempotent tunnel CNAME; rollback restores files only.
        run([args.cloudflared, "tunnel", "--origincert", args.origincert, "route", "dns", value["tunnel"], args.host])
    written, restarted = [], False
    try:
        if value["nginx_changed"]:
            args.nginx_conf.write_text(value["rendered"])
            args.nginx_conf.chmod(0o644)
            written.append(args.nginx_conf)
            run(["nginx", "-t"])
        if route_changed:
            args.config.write_text(value["candidate"])
            written.append(args.config)
        if bindings_changed:
            args.bindings.write_text(value["bindings"])
            written.append(args.bindings)
        if value["nginx_changed"]:
            run(["systemctl", "reload", "nginx"])
        if route_changed:
            restarted = True
            run(["systemctl", "restart", args.unit])
    except Exception:
        problems = []
        for file in written:
            prior = backup / file.name
            try:
                if prior.exists():
                    shutil.copy2(prior, file)
                else:
                    file.unlink(missing_ok=True)
            except OSError as exc:
                problems.append(f"restore {file}: {exc}")
        nginx_touched = args.nginx_conf in written
        for command, needed in ((["nginx", "-t"], nginx_touched), (["systemctl", "reload", "nginx"], nginx_touched),
                                (["systemctl", "restart", args.unit], restarted)):
            if needed:
                try:
                    run(command)
                except Exception as exc:
                    problems.append(" ".join(command) + f": {exc}")
        print("Installation failed; restored changed files from", backup, file=sys.stderr)
        for problem in problems:
            print("Rollback needs attention:", problem, file=sys.stderr)
        raise
    print(f"Installed {args.environment.upper()} MCP ingress. Configuration rollback:", backup)


def main(argv=None):
    parser, args = parse(argv)
    value = plan(parser, args)
    validate_ingress(args, value["candidate"])
    if args.dry_run:
        show(args, value)
        print("Dry run: no configuration, DNS, nginx or service change was made.")
        return
    install(args, value)


if __name__ == "__main__":
    main()
