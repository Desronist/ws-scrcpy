import WebSocket from 'ws';
import * as os from 'os';
import { EmulatorOrchestrator, EmulatorInfo } from '../EmulatorOrchestrator';
import { Service } from '../../services/Service';

export class AgentService implements Service {
    private static instance: AgentService;
    private ws?: WebSocket;
    private orchestrator: EmulatorOrchestrator;
    private serverUrl: string;
    private reconnectInterval: number;
    private lastEmulatorsState: EmulatorInfo[] = [];
    private scrcpyPort: number;

    private constructor() {
        this.orchestrator = new EmulatorOrchestrator();
        this.serverUrl = process.env.SERVER_URL || 'ws://localhost:3000';
        this.reconnectInterval = parseInt(process.env.RECONNECT_INTERVAL || '5000', 10);
        this.scrcpyPort = parseInt(process.env.SCRCPY_PORT || '8000', 10);
    }

    public static getInstance(): AgentService {
        if (!AgentService.instance) {
            AgentService.instance = new AgentService();
        }
        return AgentService.instance;
    }

    public static hasInstance(): boolean {
        return !!AgentService.instance;
    }

    public async start(): Promise<void> {
        this.connect();
    }

    public getName(): string {
        return 'Dashboard Agent Service';
    }

    public release(): void {
        if (this.ws) {
            this.ws.terminate();
        }
    }

    private connect(): void {
        console.log(`[AgentService] Connecting to main server at ${this.serverUrl}...`);
        const ws = new WebSocket(this.serverUrl);
        this.ws = ws;

        ws.on('open', async () => {
            console.log('[AgentService] Connected to main server successfully!');
            
            const systemImages = await this.orchestrator.getSystemImages();
            ws.send(JSON.stringify({
                type: 'identity',
                data: {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    arch: os.arch(),
                    systemImages: systemImages,
                    scrcpyPort: this.scrcpyPort
                }
            }));

            try {
                const initialList = await this.orchestrator.getEmulators();
                this.lastEmulatorsState = JSON.parse(JSON.stringify(initialList));
                ws.send(JSON.stringify({ type: 'emulator_initial_list', data: initialList }));
            } catch (err) {
                console.error('[AgentService] Initial state fetch failed:', (err as Error).message);
            }

            const deltaCheckInterval = setInterval(async () => {
                if (ws.readyState !== WebSocket.OPEN) {
                    clearInterval(deltaCheckInterval);
                    return;
                }

                try {
                    const currentState = await this.orchestrator.getEmulators();
                    const delta: any = { added: [], removed: [], updated: [] };

                    currentState.forEach(current => {
                        const prev = this.lastEmulatorsState.find(p => p.name === current.name);
                        if (!prev) {
                            delta.added.push(current);
                        } else if (prev.status !== current.status || prev.serial !== current.serial) {
                            delta.updated.push(current);
                        }
                    });

                    this.lastEmulatorsState.forEach(prev => {
                        if (!currentState.find(c => c.name === prev.name)) {
                            delta.removed.push(prev.name);
                        }
                    });

                    if (delta.added.length > 0 || delta.removed.length > 0 || delta.updated.length > 0) {
                        ws.send(JSON.stringify({ type: 'emulator_delta', data: delta }));
                        this.lastEmulatorsState = JSON.parse(JSON.stringify(currentState));
                    }
                } catch (err) {
                    console.error('[AgentService] Delta check failed:', (err as Error).message);
                }
            }, 3000);
        });

        ws.on('message', async (data: Buffer | string | any) => {
            try {
                const parsed = JSON.parse(data.toString());
                if (parsed.type === 'emulator_command') {
                    const { action, name } = parsed.data;
                    console.log(`[AgentService] Command: ${action} for ${name}`);
                    
                    let result;
                    try {
                        switch(action) {
                            case 'start': result = await this.orchestrator.startEmulator(name); break;
                            case 'stop': result = await this.orchestrator.stopEmulator(name); break;
                            case 'delete': result = await this.orchestrator.deleteEmulator(name); break;
                            case 'stream': result = await this.orchestrator.startStreaming(name, parsed.data.destinationUrl); break;
                            case 'stop_stream': result = await this.orchestrator.stopStreaming(name); break;
                            case 'create': result = await this.orchestrator.createEmulator(name, parsed.data.systemImage); break;
                        }
                        if (result) {
                            ws.send(JSON.stringify({ type: 'command_result', data: { ...result, action, name } }));
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'command_result', data: { success: false, message: (err as Error).message, action, name } }));
                    }
                } else if (parsed.type === 'init_scrcpy_tunnel') {
                    this.handleTunnel(parsed.data.tunnelId, parsed.data.targetUrl);
                }
            } catch (e) {}
        });

        ws.on('error', (err) => console.error(`[AgentService] WS Error: ${err.message}`));
        ws.on('close', () => {
            console.log(`[AgentService] Connection lost. Retrying in ${this.reconnectInterval/1000}s...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        });
    }

    private handleTunnel(tunnelId: string, targetUrl: string): void {
        const tunnelServerUrl = this.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/scrcpy-tunnel-provider/' + tunnelId;
        const localScrcpyUrl = `ws://localhost:${this.scrcpyPort}${targetUrl || ''}`;
        
        console.log(`[AgentService] Tunneling: ${localScrcpyUrl} <-> ${tunnelServerUrl}`);
        
        const serverSide = new WebSocket(tunnelServerUrl);
        const localSide = new WebSocket(localScrcpyUrl);

        const pipe = (source: WebSocket, target: WebSocket) => {
            source.on('message', (data: Buffer | any, isBinary: boolean) => {
                if (target.readyState === WebSocket.OPEN) {
                    target.send(data, { binary: isBinary });
                }
            });
        };

        serverSide.on('open', () => {
            localSide.on('open', () => {
                pipe(serverSide, localSide);
                pipe(localSide, serverSide);
            });
        });

        const closeAll = () => {
            if (serverSide.readyState <= 1) serverSide.terminate();
            if (localSide.readyState <= 1) localSide.terminate();
        };

        serverSide.on('close', closeAll);
        localSide.on('close', closeAll);
        serverSide.on('error', closeAll);
        localSide.on('error', closeAll);
    }
}
