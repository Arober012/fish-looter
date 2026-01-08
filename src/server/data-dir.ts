import path from 'path';

export function getDataDir(): string {
    const configured = process.env.DATA_DIR;
    if (configured && configured.trim()) {
        return path.resolve(configured);
    }
    return path.resolve(process.cwd(), 'data');
}

export function resolveInDataDir(...parts: string[]): string {
    return path.join(getDataDir(), ...parts);
}
