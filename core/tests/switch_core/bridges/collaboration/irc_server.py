from __future__ import annotations

import asyncio

from switch_core.bridges.collaboration.irc.protocol import Line, fold, parse


class WireServer:
    """Scripted IRC transport, with captured client commands and controllable replies."""

    def __init__(self, mapping="ascii"):
        self.mapping = mapping
        self.received: list[Line] = []
        self.connections = 0
        self.writers: list[asyncio.StreamWriter] = []
        self.tasks: set[asyncio.Task] = set()
        self.modes: dict[str, str] = {}
        self.accounts: dict[str, str] = {}
        self.names: dict[str, str] = {}
        self.refuse_modes = False
        self.refuse_invites = False
        self.refuse_messages = False
        self.nick = "switch"

    async def start(self):
        self.server = await asyncio.start_server(self._accept, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()
        for writer in self.writers:
            writer.close()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def emit(self, text):
        self.writers[-1].write((text + "\r\n").encode())
        await self.writers[-1].drain()

    async def _accept(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        self.connections += 1
        self.writers.append(writer)
        try:
            while raw := await reader.readline():
                line = parse(raw.decode())
                self.received.append(line)
                command, params = line.command, line.params
                if command == "NICK":
                    self.nick = params[0]
                elif command == "CAP" and params[0] == "LS":
                    await self.emit(
                        f":server CAP {self.nick} LS :account-tag server-time message-tags echo-message labeled-response"
                    )
                elif command == "CAP" and params[0] == "REQ":
                    await self.emit(f":server CAP {self.nick} ACK :{params[1]}")
                elif command == "CAP" and params[0] == "END":
                    await self.emit(f":server 001 {self.nick} :Welcome")
                    await self.emit(
                        f":server 005 {self.nick} CASEMAPPING={self.mapping} :supported"
                    )
                    await self.emit(f":server 376 {self.nick} :End of MOTD")
                elif command == "JOIN":
                    channel = fold(params[0], self.mapping)
                    self.modes.setdefault(channel, "+nt")
                    await self.emit(f":{self.nick}!u@localhost JOIN :{channel}")
                    await self.emit(
                        f":server 353 {self.nick} = {channel} :{self.names.get(channel, '@' + self.nick)}"
                    )
                    await self.emit(f":server 366 {self.nick} {channel} :End of names")
                elif command == "MODE":
                    channel = fold(params[0], self.mapping)
                    if len(params) > 1:
                        if self.refuse_modes:
                            await self.emit(
                                f":server 482 {self.nick} {channel} :Permission denied"
                            )
                        else:
                            self.modes[channel] = "+ntsi"
                            await self.emit(
                                f":{self.nick}!u@localhost MODE {channel} :+si"
                            )
                    else:
                        await self.emit(
                            f":server 324 {self.nick} {channel} :{self.modes[channel]}"
                        )
                elif command == "PART":
                    await self.emit(f":{self.nick}!u@localhost PART :{params[0]}")
                elif command == "PRIVMSG":
                    if self.refuse_messages:
                        await self.emit(
                            f"@label={line.tags['label']} :server 404 {self.nick} {params[0]} :Cannot send"
                        )
                        continue
                    tag = f"label={line.tags['label']};" if "label" in line.tags else ""
                    await self.emit(
                        f"@{tag}msgid=post-{len(self.received)} :{self.nick}!u@localhost PRIVMSG {params[0]} :{params[1]}"
                    )
                elif command == "WHOIS":
                    nick = params[0]
                    if nick in self.accounts:
                        await self.emit(
                            f":server 330 {self.nick} {nick} {self.accounts[nick]} :logged in"
                        )
                    await self.emit(f":server 318 {self.nick} {nick} :End of WHOIS")
                elif command == "INVITE":
                    if self.refuse_invites:
                        await self.emit(
                            f":server 482 {self.nick} {params[1]} :Permission denied"
                        )
                        continue
                    await self.emit(f":server 341 {self.nick} {params[0]} :{params[1]}")
        finally:
            writer.close()
            self.tasks.discard(task)
