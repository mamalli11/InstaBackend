import { ApiProperty, PartialType } from "@nestjs/swagger";
import { CreatePostDto } from "./create-post.dto";
import { IsEnum, IsString, Length } from "class-validator";
import { PostStatus } from "../enums/post.enum";

export class UpdatePostDto  {
	@ApiProperty({ description: "max Length 300" })
	@Length(1, 300)
	@IsString()
	caption: string;
    @ApiProperty({ default: PostStatus.Published, enum: PostStatus })
	@IsEnum(PostStatus)
	status: PostStatus;
}
