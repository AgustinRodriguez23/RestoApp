import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { redisProvider } from './redis.provider';

@Module({
  providers: [redisProvider, CacheService],
  exports: [CacheService],
})
export class CacheModule {}
