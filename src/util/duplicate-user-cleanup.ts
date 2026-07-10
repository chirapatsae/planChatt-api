import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { hashCitizenId, decryption } from './encryption.util';

/**
 * Script to identify and clean up duplicate users
 * This script will:
 * 1. Find users with the same name but different hash values
 * 2. Decrypt their citizen IDs to check if they're actually the same person
 * 3. Merge duplicate users (keeping the oldest one)
 * 4. Report the cleanup results
 */

export class DuplicateUserCleanup {
  constructor(private dataSource: DataSource) {}

  /**
   * Find potential duplicate users by name
   */
  async findDuplicateUsers(): Promise<Map<string, User[]>> {
    const userRepository = this.dataSource.getRepository(User);
    
    // Get all users with their work history
    const users = await userRepository.find({
      relations: ['workHistory'],
      order: { createAt: 'ASC' } // Oldest first
    });

    const nameGroups = new Map<string, User[]>();

    for (const user of users) {
      const fullName = `${user.prefix} ${user.firstname} ${user.lastname}`.trim();
      
      if (!nameGroups.has(fullName)) {
        nameGroups.set(fullName, []);
      }
      nameGroups.get(fullName)!.push(user);
    }

    // Filter to only groups with multiple users
    const duplicates = new Map<string, User[]>();
    for (const [name, userList] of nameGroups) {
      if (userList.length > 1) {
        duplicates.set(name, userList);
      }
    }

    return duplicates;
  }

  /**
   * Verify if users are actually duplicates by comparing decrypted citizen IDs
   */
  async verifyDuplicates(users: User[]): Promise<{ isDuplicate: boolean; actualPids: string[] }> {
    const actualPids: string[] = [];
    
    for (const user of users) {
      try {
        // AUTH-REDESIGN: citizenId is now nullable (admin-created members
        // have no national ID). A user with no citizenId cannot be a ThaID
        // duplicate — skip it rather than attempting to decrypt undefined.
        if (!user.citizenId) {
          continue;
        }
        const decryptedPid = await decryption(user.citizenId);
        actualPids.push(decryptedPid);
      } catch (error) {
        console.error(`Failed to decrypt citizen ID for user ${user.id}:`, error);
        return { isDuplicate: false, actualPids: [] };
      }
    }

    // Check if all PIDs are the same
    const uniquePids = new Set(actualPids);
    const isDuplicate = uniquePids.size === 1;

    return { isDuplicate, actualPids };
  }

  /**
   * Merge duplicate users - keep the oldest one, transfer work history to it
   */
  async mergeDuplicateUsers(users: User[]): Promise<{ kept: User; removed: User[] }> {
    const userRepository = this.dataSource.getRepository(User);
    
    // Sort by creation date - keep the oldest
    const sortedUsers = users.sort((a, b) => 
      new Date(a.createAt).getTime() - new Date(b.createAt).getTime()
    );
    
    const keptUser = sortedUsers[0];
    const usersToRemove = sortedUsers.slice(1);

    console.log(`\nMerging ${usersToRemove.length} duplicate users into user ${keptUser.id} (${keptUser.firstname} ${keptUser.lastname})`);

    // Transfer work history from duplicate users to the kept user
    for (const userToRemove of usersToRemove) {
      if (userToRemove.workHistory && userToRemove.workHistory.length > 0) {
        console.log(`  Transferring ${userToRemove.workHistory.length} work history records from user ${userToRemove.id}`);
        
        // Update work history to point to the kept user
        await userRepository.query(
          'UPDATE work_history SET user_id = $1 WHERE user_id = $2',
          [keptUser.id, userToRemove.id]
        );
      }

      // Soft delete the duplicate user
      await userRepository.softDelete(userToRemove.id);
      console.log(`  Soft deleted user ${userToRemove.id}`);
    }

    return { kept: keptUser, removed: usersToRemove };
  }

  /**
   * Main cleanup process
   */
  async cleanup(): Promise<void> {
    console.log('Starting duplicate user cleanup...\n');

    try {
      // Find potential duplicates
      const duplicateGroups = await this.findDuplicateUsers();
      console.log(`Found ${duplicateGroups.size} groups of users with the same name`);

      let totalDuplicates = 0;
      let totalMerged = 0;

      for (const [name, users] of duplicateGroups) {
        console.log(`\nChecking group: ${name} (${users.length} users)`);
        
        // Verify if they're actually duplicates
        const { isDuplicate, actualPids } = await this.verifyDuplicates(users);
        
        if (isDuplicate) {
          console.log(`  ✓ Confirmed duplicates - same PID: ${actualPids[0]}`);
          console.log(`  Hash values: ${users.map(u => u.citizenIdHash).join(', ')}`);
          
          totalDuplicates += users.length - 1; // -1 because we keep one
          
          // Merge the duplicates
          const { kept, removed } = await this.mergeDuplicateUsers(users);
          totalMerged += removed.length;
          
          console.log(`  ✓ Merged ${removed.length} duplicates into user ${kept.id}`);
        } else {
          console.log(`  ✗ Not duplicates - different PIDs: ${actualPids.join(', ')}`);
        }
      }

      console.log(`\n=== CLEANUP SUMMARY ===`);
      console.log(`Total duplicate users found: ${totalDuplicates}`);
      console.log(`Total users merged: ${totalMerged}`);
      console.log(`Groups processed: ${duplicateGroups.size}`);

    } catch (error) {
      console.error('Error during cleanup:', error);
      throw error;
    }
  }

  /**
   * Dry run - show what would be cleaned up without making changes
   */
  async dryRun(): Promise<void> {
    console.log('DRY RUN - No changes will be made\n');

    try {
      const duplicateGroups = await this.findDuplicateUsers();
      console.log(`Found ${duplicateGroups.size} groups of users with the same name`);

      let totalDuplicates = 0;

      for (const [name, users] of duplicateGroups) {
        console.log(`\nChecking group: ${name} (${users.length} users)`);
        
        const { isDuplicate, actualPids } = await this.verifyDuplicates(users);
        
        if (isDuplicate) {
          console.log(`  ✓ Would merge - same PID: ${actualPids[0]}`);
          console.log(`  Hash values: ${users.map(u => u.citizenIdHash).join(', ')}`);
          console.log(`  User IDs: ${users.map(u => u.id).join(', ')}`);
          console.log(`  Creation dates: ${users.map(u => u.createAt.toISOString()).join(', ')}`);
          
          totalDuplicates += users.length - 1;
        } else {
          console.log(`  ✗ Not duplicates - different PIDs: ${actualPids.join(', ')}`);
        }
      }

      console.log(`\n=== DRY RUN SUMMARY ===`);
      console.log(`Total duplicate users that would be merged: ${totalDuplicates}`);
      console.log(`Groups that would be processed: ${duplicateGroups.size}`);

    } catch (error) {
      console.error('Error during dry run:', error);
      throw error;
    }
  }
}

// Example usage:
// const cleanup = new DuplicateUserCleanup(dataSource);
// await cleanup.dryRun(); // First run this to see what would be changed
// await cleanup.cleanup(); // Then run this to actually make the changes
