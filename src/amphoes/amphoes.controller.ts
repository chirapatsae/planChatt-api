import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AmphoesService } from './amphoes.service';
import { CreateAmphoeDto } from './dto/create-amphoe.dto';
import { UpdateAmphoeDto } from './dto/update-amphoe.dto';
import { JwtAuthGuard } from 'src/auth/auth.guard';

@Controller({
  path: 'amphoes',
  version: '1',
})
@UseGuards(JwtAuthGuard)
export class AmphoesController {
  constructor(private readonly amphoesService: AmphoesService) {}

  @Post()
  create(@Body() createAmphoeDto: CreateAmphoeDto) {
    return this.amphoesService.create(createAmphoeDto);
  }

  @Get()
  findAll() {
    return this.amphoesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.amphoesService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateAmphoeDto: UpdateAmphoeDto) {
    return this.amphoesService.update(id, updateAmphoeDto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('mode') mode: 'soft' | 'hard' = 'soft',
  ) {
    return mode === 'soft'
      ? this.amphoesService.softRemove(id)
      : this.amphoesService.remove(id);
  }

  @Patch(':id/restore')
  restore(@Param('id') id: string) {
    return this.amphoesService.restore(id);
  }
}
