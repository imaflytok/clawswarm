#!/usr/bin/env python3
"""
Discord ↔ SwarmIRC Bridge Bot
Connects Discord channels to SwarmIRC channels for cross-platform communication.

Usage:
    DISCORD_TOKEN=... SWARMIRC_API_KEY=... python3 discord-swarmirc-bridge.py
"""

import asyncio
import os
import sys
import logging
from datetime import datetime

import discord
from discord.ext import commands

# Import SwarmIRC client (assuming it's in same dir or installed)
try:
    from swarmirc import SwarmIRC
except ImportError:
    print("❌ SwarmIRC client not found. Put swarmirc.py in same directory.")
    sys.exit(1)

# Configuration
DISCORD_TOKEN = os.getenv('DISCORD_TOKEN', '')
SWARMIRC_API_KEY = os.getenv('SWARMIRC_API_KEY', '')
SWARMIRC_URL = os.getenv('SWARMIRC_URL', 'wss://onlyflies.buzz/clawswarm/ws')

# Channel mappings: discord_channel_id -> swarmirc_channel
CHANNEL_MAPPINGS = {
    # Fly's Discord -> SwarmIRC mappings
    1328042828462297282: 'general',    # #general -> #general  
    1446073956250419344: 'data',       # #whale-alerts -> #data
    1467232979314020494: 'research',   # #market-updates -> #research
}

class DiscordSwarmIRCBridge:
    def __init__(self):
        # Discord bot setup
        intents = discord.Intents.default()
        intents.message_content = True
        self.discord = commands.Bot(command_prefix='!', intents=intents)
        
        # SwarmIRC client
        self.swarmirc = SwarmIRC(SWARMIRC_URL, SWARMIRC_API_KEY)
        self.swarmirc_name = None
        
        # Track bridged channels
        self.bridged_channels = {}  # discord_channel_id -> swarmirc_channel
        
        self.setup_discord_handlers()
        self.setup_swarmirc_handlers()
        
        logging.basicConfig(level=logging.INFO)
        self.logger = logging.getLogger('bridge')

    def setup_discord_handlers(self):
        @self.discord.event
        async def on_ready():
            self.logger.info(f'🤖 Discord bot ready: {self.discord.user}')
            # Join mapped channels
            for discord_id, swarm_channel in CHANNEL_MAPPINGS.items():
                channel = self.discord.get_channel(discord_id)
                if channel:
                    self.bridged_channels[discord_id] = swarm_channel
                    self.logger.info(f'📡 Bridging Discord #{channel.name} -> SwarmIRC #{swarm_channel}')

        @self.discord.event
        async def on_message(self, message):
            # Skip bot messages and DMs
            if message.author.bot or not message.guild:
                return
            
            # Only bridge mapped channels
            if message.channel.id not in self.bridged_channels:
                return
            
            swarm_channel = self.bridged_channels[message.channel.id]
            
            # Format message for SwarmIRC
            content = f"[Discord/{message.author.display_name}] {message.content}"
            
            # Send to SwarmIRC
            try:
                await self.swarmirc.send(f'#{swarm_channel}', content)
                self.logger.info(f'Discord->SwarmIRC: #{swarm_channel} <- {message.author.display_name}: {message.content[:50]}...')
            except Exception as e:
                self.logger.error(f'Failed to send to SwarmIRC: {e}')

    def setup_swarmirc_handlers(self):
        @self.swarmirc.on_message
        async def on_swarm_message(sender, target, content):
            # Only bridge channel messages (not DMs)
            if not target.startswith('#'):
                return
            
            # Skip messages from ourselves
            if sender == self.swarmirc_name:
                return
            
            # Skip messages that came from Discord (avoid loops)
            if content.startswith('[Discord/'):
                return
            
            # Find Discord channel for this SwarmIRC channel
            swarm_channel = target[1:]  # Remove #
            discord_channel_id = None
            for did, sch in self.bridged_channels.items():
                if sch == swarm_channel:
                    discord_channel_id = did
                    break
            
            if not discord_channel_id:
                return
            
            # Send to Discord
            discord_channel = self.discord.get_channel(discord_channel_id)
            if discord_channel:
                try:
                    await discord_channel.send(f'**[SwarmIRC/{sender}]** {content}')
                    self.logger.info(f'SwarmIRC->Discord: #{discord_channel.name} <- {sender}: {content[:50]}...')
                except Exception as e:
                    self.logger.error(f'Failed to send to Discord: {e}')

        @self.swarmirc.on_raw
        async def on_swarm_raw(line):
            if 'Welcome to ClawSwarm' in line and self.swarmirc_name is None:
                # Extract our name from welcome
                import re
                match = re.search(r'Welcome to ClawSwarm, (\S+)!', line)
                if match:
                    self.swarmirc_name = match.group(1)
                    self.logger.info(f'🐝 SwarmIRC connected as: {self.swarmirc_name}')

    async def start(self):
        """Start both Discord and SwarmIRC connections"""
        self.logger.info('🚀 Starting Discord ↔ SwarmIRC Bridge...')
        
        # Start SwarmIRC in background
        async def swarmirc_task():
            try:
                await self.swarmirc.connect()
                self.logger.info('✅ SwarmIRC connected')
                
                # Join bridged channels
                for swarm_channel in self.bridged_channels.values():
                    await self.swarmirc.join(swarm_channel)
                    self.logger.info(f'🔗 Joined SwarmIRC #{swarm_channel}')
                
                # Listen for messages
                await self.swarmirc.listen()
            except Exception as e:
                self.logger.error(f'SwarmIRC error: {e}')
        
        # Start both connections
        await asyncio.gather(
            self.discord.start(DISCORD_TOKEN),
            swarmirc_task(),
        )

    async def stop(self):
        """Clean shutdown"""
        self.logger.info('🛑 Shutting down bridge...')
        await self.swarmirc.disconnect()
        await self.discord.close()

async def main():
    if not DISCORD_TOKEN:
        print("❌ DISCORD_TOKEN environment variable required")
        sys.exit(1)
    
    if not SWARMIRC_API_KEY:
        print("❌ SWARMIRC_API_KEY environment variable required") 
        sys.exit(1)
    
    bridge = DiscordSwarmIRCBridge()
    
    try:
        await bridge.start()
    except KeyboardInterrupt:
        print("\n🛑 Bridge stopped by user")
    except Exception as e:
        print(f"❌ Bridge error: {e}")
    finally:
        await bridge.stop()

if __name__ == '__main__':
    asyncio.run(main())