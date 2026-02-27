use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

// Replace this with the real program id after first `anchor deploy`.
// Use a placeholder that is a valid Base58-encoded 32-byte public key for now.
declare_id!("11111111111111111111111111111111");

#[program]
pub mod chess_bet_escrow {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.owner = ctx.accounts.owner.key();
        cfg.resolver = Pubkey::default();
        cfg.game_counter = 0;
        Ok(())
    }

    pub fn set_resolver(ctx: Context<SetResolver>, resolver: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.owner, ctx.accounts.owner.key(), EscrowError::NotOwner);
        cfg.resolver = resolver;
        Ok(())
    }

    pub fn create_lobby(
        ctx: Context<CreateLobby>,
        game_id: u64,
        stake_lamports: u64,
    ) -> Result<()> {
        require!(stake_lamports > 0, EscrowError::StakeTooLow);

        let cfg = &mut ctx.accounts.config;
        let player1 = &ctx.accounts.player1;
        let game = &mut ctx.accounts.game;

        let expected_id = cfg.game_counter.checked_add(1).ok_or(EscrowError::Overflow)?;
        require!(game_id == expected_id, EscrowError::BadGameId);
        cfg.game_counter = expected_id;

        game.game_id = game_id;
        game.player1 = player1.key();
        game.player2 = Pubkey::default();
        game.bet_lamports = stake_lamports;
        game.active = true;
        game.winner = Pubkey::default();

        let cpi_accounts = Transfer {
            from: player1.to_account_info(),
            to: game.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, stake_lamports)?;

        Ok(())
    }

    pub fn join_lobby(ctx: Context<JoinLobby>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player2 = &ctx.accounts.player2;

        require!(game.active, EscrowError::GameNotActive);
        require!(game.player2 == Pubkey::default(), EscrowError::LobbyHasOpponent);

        let stake = game.bet_lamports;
        require!(stake > 0, EscrowError::StakeTooLow);

        let cpi_accounts = Transfer {
            from: player2.to_account_info(),
            to: game.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, stake)?;

        game.player2 = player2.key();
        Ok(())
    }

    pub fn cancel_lobby(ctx: Context<CancelLobby>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player1 = &ctx.accounts.player1;

        require!(game.active, EscrowError::GameNotActive);
        require!(game.player2 == Pubkey::default(), EscrowError::LobbyHasOpponent);
        require_keys_eq!(game.player1, player1.key(), EscrowError::NotCreator);

        let stake = game.bet_lamports;
        require!(stake > 0, EscrowError::StakeTooLow);

        **game.to_account_info().try_borrow_mut_lamports()? -= stake;
        **player1.to_account_info().try_borrow_mut_lamports()? += stake;

        game.active = false;
        Ok(())
    }

    pub fn resolve_game(ctx: Context<ResolveGame>, winner: Pubkey) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let caller = ctx.accounts.caller.key();
        let game = &mut ctx.accounts.game;

        require!(
            caller == cfg.owner || caller == cfg.resolver,
            EscrowError::NotOwnerOrResolver
        );

        require!(game.active, EscrowError::GameNotActive);
        require!(game.player2 != Pubkey::default(), EscrowError::GameNotReady);

        let player1_pk = game.player1;
        let player2_pk = game.player2;
        let stake = game.bet_lamports;
        let total_prize = stake.checked_mul(2).ok_or(EscrowError::Overflow)?;

        let game_ai = game.to_account_info();

        if winner == Pubkey::default() {
            require!(stake > 0, EscrowError::StakeTooLow);
            let mut lamports = game_ai.try_borrow_mut_lamports()?;
            require!(**lamports >= total_prize, EscrowError::InsufficientEscrow);

            **lamports -= stake;
            **ctx
                .accounts
                .player1
                .to_account_info()
                .try_borrow_mut_lamports()? += stake;

            **lamports -= stake;
            **ctx
                .accounts
                .player2
                .to_account_info()
                .try_borrow_mut_lamports()? += stake;
        } else if winner == player1_pk || winner == player2_pk {
            let mut lamports = game_ai.try_borrow_mut_lamports()?;
            require!(**lamports >= total_prize, EscrowError::InsufficientEscrow);

            **lamports -= total_prize;
            **ctx
                .accounts
                .winner_account
                .to_account_info()
                .try_borrow_mut_lamports()? += total_prize;
        } else {
            return err!(EscrowError::InvalidWinner);
        }

        game.winner = winner;
        game.active = false;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Config::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetResolver<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateLobby<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = player1,
        space = 8 + Game::SIZE,
        seeds = [b"game", config.key().as_ref(), &game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,

    #[account(mut)]
    pub player1: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinLobby<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"game", config.key().as_ref(), &game.game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,

    #[account(mut)]
    pub player2: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelLobby<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"game", config.key().as_ref(), &game.game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,

    #[account(mut)]
    pub player1: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveGame<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"game", config.key().as_ref(), &game.game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,

    pub caller: Signer<'info>,

    /// CHECK: must equal game.player1
    #[account(mut)]
    pub player1: AccountInfo<'info>,

    /// CHECK: must equal game.player2
    #[account(mut)]
    pub player2: AccountInfo<'info>,

    /// CHECK: must equal `winner` when winner != default
    #[account(mut)]
    pub winner_account: AccountInfo<'info>,
}

#[account]
pub struct Config {
    pub owner: Pubkey,
    pub resolver: Pubkey,
    pub game_counter: u64,
}

impl Config {
    pub const SIZE: usize = 32 + 32 + 8;
}

#[account]
pub struct Game {
    pub game_id: u64,
    pub player1: Pubkey,
    pub player2: Pubkey,
    pub bet_lamports: u64,
    pub active: bool,
    pub winner: Pubkey,
}

impl Game {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1 + 32;
}

#[error_code]
pub enum EscrowError {
    #[msg("Not contract owner")]
    NotOwner,
    #[msg("Not owner or resolver")]
    NotOwnerOrResolver,
    #[msg("Game not active")]
    GameNotActive,
    #[msg("Lobby already has opponent")]
    LobbyHasOpponent,
    #[msg("Only creator can cancel")]
    NotCreator,
    #[msg("Stake must be > 0")]
    StakeTooLow,
    #[msg("Game not ready")]
    GameNotReady,
    #[msg("Invalid winner")]
    InvalidWinner,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Insufficient funds in escrow account")]
    InsufficientEscrow,
    #[msg("Bad game id")]
    BadGameId,
}

