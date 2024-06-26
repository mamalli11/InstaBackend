import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	Scope,
	UnauthorizedException,
} from "@nestjs/common";
import { randomInt } from "crypto";
import { Repository } from "typeorm";
import { REQUEST } from "@nestjs/core";
import { Request, Response } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import { isEmail, isMobilePhone } from "class-validator";
import { compareSync, genSaltSync, hashSync } from "bcrypt";

import { TokenService } from "./tokens.service";
import { AuthResponse } from "./types/response";
import { AuthDto, RegisterDto } from "./dto/auth.dto";
import { OtpEntity } from "../user/entities/otp.entity";
import { UserEntity } from "../user/entities/user.entity";
import { CookieKeys } from "src/common/enums/cookie.enum";
import { ProfileEntity } from "../user/entities/profile.entity";
import { AuthMethod, RegisterMethod } from "./enums/method.enum";
import { AuthMessage, BadRequestMessage, PublicMessage } from "src/common/enums/message.enum";
import { CookiesOptionsToken } from "src/common/utils/cookie.util";

@Injectable({ scope: Scope.REQUEST })
export class AuthService {
	constructor(
		@InjectRepository(UserEntity) private userRepository: Repository<UserEntity>,
		@InjectRepository(ProfileEntity) private profileRepository: Repository<ProfileEntity>,
		@InjectRepository(OtpEntity) private otpRepository: Repository<OtpEntity>,
		@Inject(REQUEST) private request: Request,
		private tokenService: TokenService,
	) {}
	async login(authDto: AuthDto, res: Response) {
		const { method, password, username } = authDto;
		const validUsername = this.usernameValidator(method, username);
		let user: UserEntity = await this.checkExistUser(method, validUsername);

		if (!user) throw new UnauthorizedException(AuthMessage.NotFoundAccount);
		if (!compareSync(password, user.password))
			throw new UnauthorizedException("email or password is incorrect");

		const otp = await this.saveOtp(user.id, method);
		const token = this.tokenService.createOtpToken({ userId: user.id });
		const result = { token, code: otp.code };
		return this.sendResponse(res, result);
	}
	async register(registerDto: RegisterDto, res: Response) {
		const { username, fullname, emailOrPhone, password, method } = registerDto;

		const validUsername = this.usernameValidator(method, emailOrPhone);
		let user: UserEntity = await this.checkExistUser(method, validUsername);
		if (user) throw new ConflictException(AuthMessage.AlreadyExistAccount);

		user = this.userRepository.create({
			[method]: emailOrPhone,
			username,
			password: this.hashPassword(password),
		});
		user = await this.userRepository.save(user);

		let profile = this.profileRepository.create({ fullname, userId: user.id });
		profile = await this.profileRepository.save(profile);
		await this.userRepository.update({ id: user.id }, { profileId: profile.id });

		const otp = await this.saveOtp(user.id, method);
		const token = this.tokenService.createOtpToken({ userId: user.id });

		const result = { token, code: otp.code };
		return this.sendResponse(res, result);
	}
	async sendResponse(res: Response, result: AuthResponse) {
		const { token, code } = result;
		res.cookie(CookieKeys.OTP, token, CookiesOptionsToken());
		return res.json({ message: PublicMessage.SentOtp, code });
	}
	async saveOtp(userId: number, method: AuthMethod | RegisterMethod) {
		const code = randomInt(10000, 99999).toString();
		const expiresIn = new Date(Date.now() + 1000 * 60 * 2);
		let otp = await this.otpRepository.findOneBy({ userId });
		let existOtp = false;
		if (otp) {
			existOtp = true;
			otp.code = code;
			otp.expiresIn = expiresIn;
			otp.method = method;
		} else {
			otp = this.otpRepository.create({ code, expiresIn, userId, method });
		}
		otp = await this.otpRepository.save(otp);
		if (!existOtp) {
			await this.userRepository.update({ id: userId }, { otpId: otp.id });
		}
		return otp;
	}
	async checkOtp(code: string) {
		const token = this.request.cookies?.[CookieKeys.OTP];
		if (!token) throw new UnauthorizedException(AuthMessage.ExpiredCode);
		const { userId } = this.tokenService.verifyOtpToken(token);

		const otp = await this.otpRepository.findOneBy({ userId });
		if (!otp) throw new UnauthorizedException(AuthMessage.LoginAgain);

		const now = new Date();
		if (otp.expiresIn < now) throw new UnauthorizedException(AuthMessage.ExpiredCode);
		if (otp.code !== code) throw new UnauthorizedException(AuthMessage.TryAgain);
		const accessToken = this.tokenService.createAccessToken({ userId });

		if (otp.method === AuthMethod.Email) {
			await this.userRepository.update({ id: userId }, { verify_email: true });
		} else if (otp.method === AuthMethod.Phone) {
			await this.userRepository.update({ id: userId }, { verify_phone: true });
		}
		return { message: PublicMessage.LoggedIn, accessToken };
	}
	async checkExistUser(method: AuthMethod | RegisterMethod, username: string) {
		let user: UserEntity;
		const filterData: object = {
			select: [
				"id",
				"email",
				"password",
				"phone",
				"otpId",
				"username",
				"profileId",
				"new_email",
				"new_phone",
			],
		};
		if (method === AuthMethod.Phone) {
			user = await this.userRepository.findOne({
				where: { phone: username },
				...filterData,
			});
		} else if (method === AuthMethod.Email) {
			user = await this.userRepository.findOne({
				where: { email: username },
				...filterData,
			});
		} else if (method === AuthMethod.Username) {
			user = await this.userRepository.findOne({
				where: { username },
				...filterData,
			});
		} else {
			throw new BadRequestException(BadRequestMessage.InValidLoginData);
		}
		return user;
	}
	hashPassword(password: string) {
		const salt = genSaltSync(10);
		return hashSync(password, salt);
	}
	usernameValidator(method: AuthMethod | RegisterMethod, username: string) {
		switch (method) {
			case AuthMethod.Email:
				if (isEmail(username)) return username;
				throw new BadRequestException("Email format is incorrect");

			case AuthMethod.Phone:
				if (isMobilePhone(username, "fa-IR")) return username;
				throw new BadRequestException("Phone format is incorrect");

			case AuthMethod.Username:
				return username;
			default:
				throw new UnauthorizedException("username data is not valid");
		}
	}
	async validateAccessToken(token: string) {
		const { userId } = this.tokenService.verifyAccessToken(token);
		const user = await this.userRepository.findOneBy({ id: userId });
		if (!user) throw new UnauthorizedException(AuthMessage.LoginAgain);
		return user;
	}
}
