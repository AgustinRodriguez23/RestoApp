import { Global, Module } from '@nestjs/common';
import { UpstreamClient } from './upstream-client';

@Global()
@Module({ providers: [UpstreamClient], exports: [UpstreamClient] })
export class UpstreamModule {}
