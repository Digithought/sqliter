# Window Function Processing Architecture

This document outlines the architecture and execution flow for SQL window functions in SQLiter.

## Overview

Window functions perform calculations across a set of table rows that are somehow related to the current row. Unlike aggregate functions, they do not collapse rows; they return a value for *each* row based on the defined window.

SQLiter implements window functions using a multi-pass approach involving an ephemeral sorter table:

1.  **Main Query Pass:** The main part of the `SELECT` query (FROM, WHERE, GROUP BY, HAVING) is executed, producing an intermediate result set.
2.  **Sorter Population:** This intermediate result set is used to populate an ephemeral B-Tree table (the "window sorter"), managed internally by the compiler.
3.  **Window Function Pass:** The VDBE executes a dedicated pass over the sorted data in the ephemeral table to calculate the window function results.
4.  **Final Projection:** The results from the window sorter (including the calculated window function values) are projected to produce the final output rows.

## Key Components

*   **`src/compiler/window.ts` (`setupWindowSorter`)**: 
    *   Analyzes `SELECT` list and window function definitions.
    *   Determines the necessary columns for the sorter (partition keys, order keys, function arguments, placeholders for results).
    *   Defines the schema and sort order (`P4SortKey`) for the ephemeral sorter table.
    *   Allocates a cursor and registers for the sorter.
    *   Returns `WindowSorterInfo` containing all setup details.
*   **`src/compiler/compiler.ts`**: 
    *   Orchestrates the overall query compilation.
    *   Calls `setupWindowSorter` if window functions are present.
    *   Emits VDBE code to populate the sorter table.
    *   Calls `compileWindowFunctionsPass` to generate the VDBE code for the window function calculations.
    *   Emits VDBE code for the final projection.
*   **`src/compiler/window_pass.ts` (`compileWindowFunctionsPass` and helpers)**:
    *   Generates the VDBE program for the window function pass.
    *   **Main Loop:** Iterates through the sorted rows in the window sorter cursor.
    *   **Partition Detection:** Compares partition key columns of the current row with the previous row to detect partition boundaries and reset relevant state (row counters, ranks).
    *   **Frame Calculation & Function Execution:** For each row, calculates the result for each window function.
        *   **Numbering Functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`):** Calculated based on partition counters and order key comparisons.
        *   **Aggregate Functions (`SUM`, `AVG`, `COUNT`, etc.):**
            *   Uses `compileFrameBoundary` to determine the start and end rows of the current row's frame.
            *   Uses `compileFrameAggregate` to iterate through rows within the calculated frame boundaries, calling the aggregate's `xStep` function via the `Function` opcode.
            *   Calls the aggregate's `xFinal` function via the `Function` opcode.
        *   **Value Functions (`FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`):**
            *   Uses `compileFrameBoundary` to position the cursor at the desired row within the frame (e.g., frame start for `FIRST_VALUE`).
            *   Uses the `VColumn` opcode to retrieve the argument value from that row.
            *   (`NTH_VALUE` not yet implemented).
        *   **Offset Functions (`LAG`, `LEAD`):**
            *   Uses the `SeekRelative` opcode to move the cursor forward or backward by the specified offset.
            *   Uses `VColumn` to retrieve the argument value if the seek was successful.
            *   Handles default values if the seek fails (e.g., goes outside the partition).
    *   **Cursor Management:** Employs helper functions (`compileSaveCursorPosition`, `compileRestoreCursorPosition`) to save and restore the cursor's position using rowids, ensuring functions that navigate the cursor (like `FIRST_VALUE`, `LAG`) don't interfere with subsequent calculations for the same original row.
*   **`src/vdbe/engine.ts`**: 
    *   Executes the VDBE instructions generated by the compiler.
    *   Implements the logic for relevant opcodes like `Rewind`, `VNext`, `VColumn`, `VRowid`, `SeekRelative`, `SeekRowid`, `Function`, comparison opcodes, etc.
    *   `SeekRelative` and `SeekRowid` are expected to handle partition boundaries implicitly by returning failure if a seek attempts to cross a boundary (this depends on the underlying VTab implementation, e.g., `MemoryTable`).
*   **`src/vtab/memory-table.ts`**: 
    *   Implements the `VirtualTableModule` interface for the ephemeral sorter.
    *   Provides implementations for `xSeekRelative` and `xSeekToRowid` based on its internal B-Tree structure and transactional buffer, ensuring partition consistency.

## Execution Flow (Window Pass)

For each row fetched from the sorter (`VNext`):

1.  Get Current Rowid (`VRowid` -> `regCurrentRowPtr`).
2.  Detect Partition Boundary: Compare current partition keys with previous; if different, reset counters/ranks and store `regCurrentRowPtr` as `regPartitionStartRowid`.
3.  Calculate Basic Functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`) based on counters and order key comparisons.
4.  **For each Window Function:**
    *   **Save Original Position:** (`compileSaveCursorPosition` using `regCurrentRowPtr`).
    *   **If Aggregate:** 
        *   Call `compileFrameBoundary` (start) -> positions cursor, returns start rowid.
        *   Call `compileFrameBoundary` (end) -> positions cursor, returns end rowid, saves end keys (for RANGE).
        *   Call `compileFrameAggregate`:
            *   Restores cursor to start rowid.
            *   Loops (`VNext`) until past end boundary (checked via rowid or keys).
            *   Calls `Function` opcode (`xStep`).
            *   Calls `Function` opcode (`xFinal`).
    *   **If `FIRST_VALUE`/`LAST_VALUE`:**
        *   Call `compileFrameBoundary` (start or end) -> positions cursor, returns boundary rowid.
        *   If boundary rowid not NULL, `VColumn` to get value.
        *   Else, result is NULL.
    *   **If `LAG`/`LEAD`:**
        *   `SeekRelative` by offset.
        *   If seek success, `VColumn` to get value.
        *   Else, use default value.
    *   **Restore Original Position:** (`compileRestoreCursorPosition` using saved original position).
5.  Store calculated window function result(s).
6.  Update previous partition/order keys.
7.  Loop to next sorter row (`VNext`).

## Key Opcodes

*   `Rewind`, `VNext`: Basic cursor iteration.
*   `VColumn`: Reading data from the sorter.
*   `VRowid`: Getting the current row identifier.
*   `SeekRelative`: Moving the cursor by a relative offset (used by `LAG`, `LEAD`, ROWS frames).
*   `SeekRowid`: Moving the cursor to a specific rowid (used by `compileRestoreCursorPosition`, frame boundary calculation for UNBOUNDED PRECEDING).
*   `Function`: Executes UDFs, including aggregate `xStep` and `xFinal`.
*   Comparison Opcodes (`Eq`, `Ne`, `Lt`, `Le`, `Gt`, `Ge`): Used for partition/order key comparisons and frame boundary checks.
*   `IfNull`, `IfTrue`, etc.: Conditional jumps for control flow.
*   `Move`, `SCopy`: Register manipulation. 
