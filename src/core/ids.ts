type _CastNumber<Input, Output> = Input extends number
    ? Input extends { readonly __type: symbol }
        ? Input
        : Output
    : Input;

/**
 * Casts Input to Output if Input is a number.
 *
 * This is safer than `as` since it won't suppress type errors and nullability.
 */
function _castNumber<Output>() {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return <Input>(value: Input) => value as _CastNumber<Input, Output>;
}

export const workspaceID = _castNumber<WorkspaceID>();
export const monitorID = _castNumber<MonitorID>();
