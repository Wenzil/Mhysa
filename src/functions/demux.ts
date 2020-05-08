import { DuplexOptions, Duplex, Transform } from "stream";

import { isReadable } from "../helpers";

type DemuxStreams = NodeJS.WritableStream | NodeJS.ReadWriteStream;

export interface DemuxOptions extends DuplexOptions {
    remultiplex?: boolean;
}

export function demux(
    construct: (
        destKey?: string,
        chunk?: any,
    ) => DemuxStreams | Array<DemuxStreams>,
    demuxBy: string | ((chunk: any) => string),
    options?: DemuxOptions,
): Duplex {
    return new Demux(construct, demuxBy, options);
}

class Demux extends Duplex {
    private streamsByKey: {
        [key: string]: Array<DemuxStreams>;
    };
    private demuxer: (chunk: any) => string;
    private construct: (destKey?: string, chunk?: any) => Array<DemuxStreams>;
    private remultiplex: boolean;
    private transform: Transform;
    constructor(
        construct: (
            destKey?: string,
            chunk?: any,
        ) => DemuxStreams | Array<DemuxStreams>,
        demuxBy: string | ((chunk: any) => string),
        options: DemuxOptions = {},
    ) {
        super(options);
        this.demuxer =
            typeof demuxBy === "string" ? chunk => chunk[demuxBy] : demuxBy;
        this.construct = (destKey: string, chunk?: any) => {
            const pipeline = construct(destKey, chunk);
            return Array.isArray(pipeline) ? pipeline : [pipeline];
        };
        this.remultiplex =
            options.remultiplex === undefined ? true : options.remultiplex;
        this.streamsByKey = {};
        this.transform = new Transform({
            ...options,
            transform: (d, _, cb) => {
                this.push(d);
                cb(null);
            },
        });

        this.on("unpipe", () => this._flush());
    }

    // tslint:disable-next-line
    public _read(size: number) {}

    public async _write(chunk: any, encoding: any, cb: any) {
        const destKey = this.demuxer(chunk);
        if (this.streamsByKey[destKey] === undefined) {
            const newPipelines = this.construct(destKey, chunk);
            this.streamsByKey[destKey] = newPipelines;

            newPipelines.forEach(newPipeline => {
                if (this.remultiplex && isReadable(newPipeline)) {
                    (newPipeline as NodeJS.ReadWriteStream).pipe(
                        this.transform,
                    );
                } else if (this.remultiplex) {
                    console.error(
                        `Pipeline construct for ${destKey} does not implement readable interface`,
                    );
                }
            });
        }
        const pipelines = this.streamsByKey[destKey];
        let pendingDrains: Array<Promise<any>> = [];

        pipelines.forEach(pipeline => {
            if (!pipeline.write(chunk, encoding)) {
                pendingDrains.push(
                    new Promise(resolve => {
                        pipeline.once("drain", () => {
                            resolve();
                        });
                    }),
                );
            }
        });
        await Promise.all(pendingDrains);
        cb();
    }

    public _flush() {
        const pipelines: Array<DemuxStreams> = [].concat.apply(
            [],
            Object.values(this.streamsByKey),
        );
        const flushPromises: Array<Promise<void>> = [];
        pipelines.forEach(pipeline => {
            flushPromises.push(
                new Promise(resolve => {
                    pipeline.once("end", () => {
                        resolve();
                    });
                }),
            );
        });
        pipelines.forEach(pipeline => pipeline.end());
        Promise.all(flushPromises).then(() => {
            this.push(null);
            this.emit("end");
        });
    }

    public _destroy(error: any, cb: (error?: any) => void) {
        const pipelines: Array<DemuxStreams> = [].concat.apply(
            [],
            Object.values(this.streamsByKey),
        );
        pipelines.forEach(p => (p as any).destroy());
        cb(error);
    }
}
