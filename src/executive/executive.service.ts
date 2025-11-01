import { Injectable } from '@nestjs/common';
import { CreateExecutiveDto } from './dto/create-executive.dto';
import { UpdateExecutiveDto } from './dto/update-executive.dto';

@Injectable()
export class ExecutiveService {
  create(createExecutiveDto: CreateExecutiveDto) {
    return 'This action adds a new executive';
  }

  findAll() {
    return `This action returns all executive`;
  }

  findOne(id: number) {
    return `This action returns a #${id} executive`;
  }

  update(id: number, updateExecutiveDto: UpdateExecutiveDto) {
    return `This action updates a #${id} executive`;
  }

  remove(id: number) {
    return `This action removes a #${id} executive`;
  }
}
