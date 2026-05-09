'use strict';

const { deslop } = require('../pipeline/steps');

/**
 * DeslopTool — remove AI writing slop from any text.
 *
 * Rules sourced from the user's writing profile:
 * https://github.com/97115104/97115104-writing-profile
 *
 * Forbidden: em dashes, "rather than", "not X but Y", "leverage", "robust",
 * "delve", "seamless", "comprehensive", "transformative", "moreover",
 * "furthermore", "in conclusion", filler openers (Sure!, Certainly!, etc.)
 */
const DeslopTool = {
  name: 'deslop',
  description: 'Remove AI writing slop from text: em dashes, forbidden phrases (leverage, robust, delve, seamless, transformative, etc.), hollow openers, and antithetical fragment constructions. Returns cleaned text.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to clean',
      },
    },
    required: ['text'],
  },

  execute({ text }) {
    if (!text) return '';
    const cleaned = deslop(String(text));
    console.log(`[deslop] ${text.length} → ${cleaned.length} chars`);
    return cleaned;
  },
};

module.exports = DeslopTool;
