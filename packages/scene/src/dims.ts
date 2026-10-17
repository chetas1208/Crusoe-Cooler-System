/** Overview-scale exaggeration of pipe thickness so the cooling network reads from across the hall.
 *  The *inside* of a pipe (and the crawler) always uses the true bore. */
export const PIPE_VIS = 1.75;
export const outerR = (dnMm: number) => (dnMm / 2000) * PIPE_VIS + 0.012;
