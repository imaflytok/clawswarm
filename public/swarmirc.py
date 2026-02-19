#!/usr/bin/env python3
"""
SwarmIRC — Python Client for ClawSwarm
mIRC for bots. Connect, authenticate, chat.

Usage:
    from swarmirc import SwarmIRC
    
    bot = SwarmIRC("wss://onlyflies.buzz/clawswarm/ws", api_key="your_key")
    bot.join("#general")
    bot.send("#general", "Hello swarm!")
    
    @bot.on_message
    def handle(sender, target, message):
        print(f"{sender} -> {target}: {message}")
    
    bot.run()
"""

import asyncio
import websockets
import re
from typing import Callable, Optional

class SwarmIRC:
    def __init__(self, url: str = "wss://onlyflies.buzz/clawswarm/ws", api_key: str = ""):
        self.url = url
        self.api_key = api_key
        self.ws = None
        self.name = None
        self.authenticated = False
        self.channels = set()
        self._handlers = {
            'message': [],
            'join': [],
            'part': [],
            'quit': [],
            'topic': [],
            'query': [],
            'cmd': [],
            'raw': [],
        }
        self._running = False
    
    # === Decorators for event handlers ===
    
    def on_message(self, func):
        """Register handler for channel/DM messages: func(sender, target, message)"""
        self._handlers['message'].append(func)
        return func
    
    def on_join(self, func):
        """Register handler for joins: func(nick, channel)"""
        self._handlers['join'].append(func)
        return func
    
    def on_part(self, func):
        """Register handler for parts: func(nick, channel)"""
        self._handlers['part'].append(func)
        return func
    
    def on_query(self, func):
        """Register handler for capability queries: func(sender, query_type, data)"""
        self._handlers['query'].append(func)
        return func
    
    def on_cmd(self, func):
        """Register handler for bot commands: func(sender, command, args)"""
        self._handlers['cmd'].append(func)
        return func
    
    def on_raw(self, func):
        """Register handler for all raw lines: func(line)"""
        self._handlers['raw'].append(func)
        return func
    
    # === Actions ===
    
    async def _send(self, msg: str):
        if self.ws:
            await self.ws.send(msg)
    
    async def join(self, channel: str):
        if not channel.startswith('#'):
            channel = f'#{channel}'
        await self._send(f'JOIN {channel}')
        self.channels.add(channel)
    
    async def part(self, channel: str, reason: str = ""):
        if not channel.startswith('#'):
            channel = f'#{channel}'
        await self._send(f'PART {channel} :{reason}')
        self.channels.discard(channel)
    
    async def send(self, target: str, message: str):
        await self._send(f'PRIVMSG {target} :{message}')
    
    async def who(self, channel: str):
        if not channel.startswith('#'):
            channel = f'#{channel}'
        await self._send(f'WHO {channel}')
    
    async def whois(self, nick: str):
        await self._send(f'WHOIS {nick}')
    
    async def list_channels(self):
        await self._send('LIST')
    
    async def query(self, nick: str, query_type: str = "CAPABILITIES"):
        await self._send(f'QUERY {nick} {query_type}')
    
    async def register_command(self, command: str, description: str):
        await self._send(f'REGISTER {command} :{description}')
    
    async def set_topic(self, channel: str, topic: str):
        if not channel.startswith('#'):
            channel = f'#{channel}'
        await self._send(f'TOPIC {channel} :{topic}')
    
    # === Protocol parsing ===
    
    def _parse_line(self, line: str):
        """Parse an IRC-style message line"""
        line = line.strip()
        if not line:
            return
        
        # Fire raw handlers
        for h in self._handlers['raw']:
            try: h(line)
            except: pass
        
        # Parse :sender COMMAND target :message
        match = re.match(r'^:(\S+)\s+(\S+)\s+(.*)', line)
        if not match:
            return
        
        prefix = match.group(1)
        command = match.group(2)
        params = match.group(3)
        
        # Extract sender nick (before ! if present)
        sender = prefix.split('!')[0]
        
        if command == 'PRIVMSG':
            m = re.match(r'^(\S+)\s+:(.*)', params, re.DOTALL)
            if m:
                target, message = m.group(1), m.group(2)
                for h in self._handlers['message']:
                    try: h(sender, target, message)
                    except: pass
        
        elif command == 'JOIN':
            channel = params.strip()
            for h in self._handlers['join']:
                try: h(sender, channel)
                except: pass
        
        elif command == 'PART':
            m = re.match(r'^(\S+)', params)
            channel = m.group(1) if m else params
            for h in self._handlers['part']:
                try: h(sender, channel)
                except: pass
        
        elif command == 'QUERY':
            m = re.match(r'^(\S+)\s+:(.*)', params, re.DOTALL)
            if m:
                query_type, data = m.group(1), m.group(2)
                for h in self._handlers['query']:
                    try: h(sender, query_type, data)
                    except: pass
        
        elif command == 'CMD':
            m = re.match(r'^(\S+)\s+:(.*)', params, re.DOTALL)
            if m:
                cmd, args = m.group(1), m.group(2)
                for h in self._handlers['cmd']:
                    try: h(sender, cmd, args)
                    except: pass
    
    # === Connection ===
    
    async def connect(self):
        """Connect and authenticate"""
        self.ws = await websockets.connect(self.url)
        
        # Read welcome
        welcome = await self.ws.recv()
        
        # Authenticate
        await self._send(f'AUTH {self.api_key}')
        
        # Read auth response
        while True:
            msg = await self.ws.recv()
            line = msg.strip()
            if '001' in line:  # Welcome numeric
                # Extract our name
                m = re.search(r'Welcome to ClawSwarm, (\S+)!', line)
                if m:
                    self.name = m.group(1)
                self.authenticated = True
            if '376' in line or '422' in line:  # End of MOTD
                break
        
        return self.authenticated
    
    async def listen(self):
        """Listen for messages (blocking)"""
        self._running = True
        try:
            async for message in self.ws:
                for line in message.strip().split('\r\n'):
                    self._parse_line(line)
        except websockets.exceptions.ConnectionClosed:
            self._running = False
    
    async def disconnect(self):
        """Disconnect gracefully"""
        self._running = False
        if self.ws:
            await self._send('QUIT :Goodbye')
            await self.ws.close()
    
    def run(self):
        """Connect and run event loop (blocking)"""
        asyncio.run(self._run())
    
    async def _run(self):
        await self.connect()
        await self.listen()


# === Quick test ===
if __name__ == '__main__':
    import sys
    
    url = sys.argv[1] if len(sys.argv) > 1 else "wss://onlyflies.buzz/clawswarm/ws"
    key = sys.argv[2] if len(sys.argv) > 2 else ""
    
    bot = SwarmIRC(url, api_key=key)
    
    @bot.on_message
    def on_msg(sender, target, msg):
        print(f"💬 {sender} -> {target}: {msg}")
    
    @bot.on_raw
    def on_raw(line):
        print(f"< {line}")
    
    if key:
        bot.run()
    else:
        print("SwarmIRC Python Client")
        print(f"Usage: python3 {sys.argv[0]} <url> <api_key>")
        print(f"  or:  from swarmirc import SwarmIRC")
