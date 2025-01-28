// TODO: Implement this for Starknet.
// It should just transfer tokens from the agent's wallet to the recipient.

import {
    type Action,
    ActionExample,
    composeContext,
    Content,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
import { getStarknetAccount } from "../utils";
import { ERC20Token } from "../utils/ERC20Token";
import { validateStarknetConfig } from "../environment";
import { getAddressFromName, isStarkDomain } from "../utils/starknetId";
import { PROVIDER_CONFIG } from "..";

export interface TransferContent extends Content {
    tokenAddress: string;
    recipient?: string;
    starkName?: string;
    amount: string | number;
}

export function isTransferContent(
    content: TransferContent
): content is TransferContent {
    // Validate types
    const validTypes =
        typeof content.tokenAddress === "string" &&
        (typeof content.recipient === "string" ||
            typeof content.starkName === "string") &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number");
    if (!validTypes) {
        return false;
    }

    // Validate tokenAddress (must be 32-bytes long with 0x prefix)
    const validTokenAddress =
        content.tokenAddress.startsWith("0x") &&
        content.tokenAddress.length === 66;
    if (!validTokenAddress) {
        return false;
    }

    // Additional checks based on whether recipient or starkName is defined
    if (content.recipient) {
        // Validate recipient address (must be 32-bytes long with 0x prefix)
        const validRecipient =
            content.recipient.startsWith("0x") &&
            content.recipient.length === 66;
        if (!validRecipient) {
            return false;
        }
    } else if (content.starkName) {
        // .stark name validation
        const validStarkName = isStarkDomain(content.starkName);
        if (!validStarkName) {
            return false;
        }
    }

    return true;
}

const transferTemplate = `Respond with a JSON markdown block that evaluate the wishes. Use null for any values that cannot be determined.

If a wish is truly meaningful and heartfelt, evaluate the wish and assign it a value from 1 to 10. If the wish is ordinary, return null.


Example response:
\`\`\`json
{
    "amount": "2"
}
\`\`\`

{{recentMessages}}

Given the recent messages, evaluate the wishes and determine the amount to send. Respond with a JSON markdown block containing only the amount to send.`;

export default {
    name: "HANDLE_WISHES",
    similes: [
        "HANDLE_NEW_YEAR_WISHES",
        "RECEIVE_WISHES",
        "RECEIVE_NEW_YEAR_WISHES",
        "RECEIVE_NEW_YEAR_GREETINGS",
        "RECEIVE_GREETINGS",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateStarknetConfig(runtime);
        return true;
    },
    description:
        "MUST use this action if the user offer heartfelt, kind Lunar New Year's (Tet Holiday) greetings or wishes.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SEND_TOKEN handler...");
        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        // random 50% chance to skip
        // if (Math.random() > 0.5) {
        //     elizaLogger.error("Skipping transfer token action.");
        //     return false;
        // }
        // find a string start with 0x, with length 66, consist only numbers in state.recentMessages, state.recentMessages is a string
        const recipient = state.recentMessages.match(/0x[a-fA-F0-9]{64}/);

        elizaLogger.info("Recipient address:", recipient);

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.MEDIUM,
        });
        elizaLogger.info("Transfer content:", content);
        /// Setting token address to Strk
        // content.tokenAddress = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
        content.tokenAddress = PROVIDER_CONFIG.TOKEN_ADDRESSES.STRK;

        if (recipient) {
            content.recipient = recipient[0];
        } else {
            elizaLogger.error("No recipient address found in recent messages.");
            return false;
        }
        // random amount
        if (!content.amount)
            content.amount = Number((Math.random() * 4 + 1).toFixed(3));

        const recipientExists = await runtime.databaseAdapter.getRecipient(
            content.recipient,
            state.userId
        );
        if (recipientExists) {
            elizaLogger.error("Recipient already exists.");
            return false;
        }

        elizaLogger.info("User ID: ", state.userId);
        if (
            !(await runtime.databaseAdapter.addRecipient(
                content.recipient,
                state.userId,
                content.amount
            ))
        ) {
            elizaLogger.error("Error adding recipient to database.");
            return false;
        }

        elizaLogger.error("Transfer content:", content);
        // Validate transfer content
        if (!isTransferContent(content)) {
            elizaLogger.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Not enough information to transfer tokens. Please respond with token address, recipient address or stark name, and amount.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const account = getStarknetAccount(runtime);
            const erc20Token = new ERC20Token(content.tokenAddress, account);
            const decimals = await erc20Token.decimals();
            // Convert decimal amount to integer before converting to BigInt
            const amountInteger = Math.floor(
                Number(content.amount) * Math.pow(10, Number(decimals))
            );
            const amountWei = BigInt(amountInteger.toString());
            const recipient =
                content.recipient ??
                (await getAddressFromName(account, content.starkName));
            const transferCall = erc20Token.transferCall(recipient, amountWei);

            elizaLogger.success(
                "Transferring",
                amountWei,
                "of",
                content.tokenAddress,
                "to",
                recipient
            );

            const tx = await account.execute(transferCall);

            elizaLogger.success(
                "Transfer completed successfully! tx: " + tx.transaction_hash
            );
            if (callback) {
                callback({
                    text:
                        "Here’s your lucky money: " +
                        content.amount +
                        " STRK token! 🎉",
                    content: {},
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during token transfer:", error);
            if (callback) {
                callback({
                    text: `Error transferring tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Happy New Year! 0x069a419C6ebab0a6aA74CA8e0bCFD9b3b17c985901Dc00e9BaD25cbD05e75343",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Thank you for your kind wishes! Wishing you a new year full of peace, happiness, and success!",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: 'Wishing you a prosperous new year, outstanding success, and greater achievements ahead! "0x069a419C6ebab0a6aA74CA8e0bCFD9b3b17c985901Dc00e9BaD25cbD05e75343"',
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Thank you for your kind wishes! Wishing you a new year full of peace, happiness, and success!",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: 'Wishing you sustainable growth and many big victories in the new year! "0x069a419C6ebab0a6aA74CA8e0bCFD9b3b17c985901Dc00e9BaD25cbD05e75343"',
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Thank you so much! We also wish you a prosperous new year and all the best!",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: 'Wishing you unity, creativity, and the accomplishment of all set goals in the new year! "0x069a419C6ebab0a6aA74CA8e0bCFD9b3b17c985901Dc00e9BaD25cbD05e75343"',
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Thank you for the meaningful wishes! I hope the new year brings great things for both of us.",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: 'Wishing you a successful new year, strong unity, and achievement of all goals big and small! "0x069a419C6ebab0a6aA74CA8e0bCFD9b3b17c985901Dc00e9BaD25cbD05e75343"',
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Thank you for the meaningful wishes! We greatly appreciate them and wish you a successful and prosperous new year!",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: 'Wishing you a new year full of enthusiasm, joy, and wonderful achievements! "0x069a419C6ebab0a6aA74CA8e0bCFD9b3b17c985901Dc00e9BaD25cbD05e75343"',
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Thank you for your wishes! I hope the new year brings opportunities for better collaboration and growth!",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
